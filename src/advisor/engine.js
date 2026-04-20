/**
 * Advisor decision engine — replaces the static 5-precedence ladder
 * in src/advisor/analyses/effort-matrix.js with a baselined, peak-aware,
 * action-oriented recommendation.
 *
 * Action ladder (per claude-code-open-bugs-2026-04-19.md and the
 * research brief §3.6):
 *
 *   1. Hard-stop      — TTE 5h < 30 min OR TTE 7d < 12h
 *   2. Model swap     — Opus + peak active + burn velocity > 2.5× baseline
 *   3. /clear         — rolling R:E < 3.0 (model attention degraded)
 *   4. /compact       — context > 60%
 *   5. on-track       — none of the above
 *
 * Output shape: a single Recommendation object that the HUD advisor
 * line and the daily-report writer both consume.
 */

import { countReadEdits, calculateRatio } from '../anomaly/constants.js';
import { computeBaselines } from './baselines.js';

/**
 * @typedef {object} Recommendation
 * @property {'increase'|'nominal'|'reduce'|'throttle'|'limit_hit'} signal
 * @property {string} action            - short imperative the user should take
 * @property {string} causalReason      - one-line "why" the user can verify
 * @property {'low'|'medium'|'high'} confidence
 * @property {string} confidenceWhy     - one-line "why this confidence"
 * @property {string} tier              - which ladder rung fired (id, not text)
 * @property {{
 *   reads: number, edits: number, ratio: number,
 *   burnRate: number, burnVelocity: number|null,
 *   fhTteSec: number|null, sdTteSec: number|null,
 *   contextPercent: number|null,
 *   peakActive: boolean
 * }} metrics
 * @property {import('./baselines.js').Baselines} baselines
 */

const HARD_STOP_5H_SEC = 30 * 60;
const HARD_STOP_7D_SEC = 12 * 3600;
const MODEL_SWAP_VELOCITY_X = 2.5;
const RE_DEGRADED_THRESHOLD = 3.0;
const RE_MIN_EDITS_FOR_SIGNAL = 3;
const COMPACT_CONTEXT_PCT = 60;

const CONFIDENCE_MIN_DURATION_LOW = 15;     // minutes
const CONFIDENCE_MIN_DURATION_MED = 60;
const CONFIDENCE_MIN_TURNS_LOW = 5;
const CONFIDENCE_MIN_TURNS_MED = 20;

/**
 * @typedef {object} EngineInput
 * @property {import('../analytics/rates.js').RateData|null} rates
 * @property {import('../data/stdin.js').UsageData|null} [usage]
 * @property {{ burnRate?: number, durationMin?: number, recentTurnsOutput?: number[] }|null} [tokenStats]
 * @property {Record<string, number>|null} [toolCounts]
 * @property {number|null} [contextPercent]
 * @property {string|null} [modelName]
 * @property {Array<object>} [history]
 */

/**
 * Build a Recommendation from current session signals + historical baselines.
 *
 * @param {EngineInput} input
 * @returns {Recommendation}
 */
export function buildRecommendation(input) {
  const baselines = computeBaselines(input.history ?? []);
  const burnRate = Number(input.tokenStats?.burnRate ?? 0);
  const fhDetail = input.rates?.fiveHourDetail ?? null;
  const sdDetail = input.rates?.sevenDayDetail ?? null;

  const fhTteSec = fhDetail?.tte ?? null;
  const sdTteSec = sdDetail?.tte ?? null;
  const peakActive = !!fhDetail?.peakActive;

  const { reads, edits } = countReadEdits(input.toolCounts ?? {});
  const ratio = calculateRatio(reads, edits);

  // Burn velocity vs personal baseline. burnP50 is the user's typical
  // tempo; >2.5× that during peak hours is the swap-to-Sonnet trigger.
  // When no baseline exists yet, velocity is null (skip the rung).
  const burnVelocity = baselines.burnP50 && baselines.burnP50 > 0
    ? burnRate / baselines.burnP50
    : null;

  const contextPercent = Number.isFinite(input.contextPercent)
    ? input.contextPercent
    : null;

  const confidence = computeConfidence(input.tokenStats);

  const decision = selectAction({
    fhTteSec,
    sdTteSec,
    peakActive,
    burnVelocity,
    modelName: input.modelName ?? '',
    ratio,
    edits,
    reads,
    contextPercent,
  });

  // Limit-hit overrides everything except hard-stop wording — surface
  // it as the canonical signal so the display layer keeps its hit-state
  // colors / glyphs.
  const limitHit = fhDetail?.level === 'hit' || sdDetail?.level === 'hit';
  const finalSignal = limitHit ? 'limit_hit' : decision.signal;

  return {
    signal: finalSignal,
    action: limitHit ? 'wait for window reset' : decision.action,
    causalReason: limitHit
      ? `${fhDetail?.level === 'hit' ? '5h' : '7d'} window at 100%`
      : decision.causalReason,
    confidence: confidence.level,
    confidenceWhy: confidence.why,
    tier: limitHit ? 'limit_hit' : decision.tier,
    metrics: {
      reads, edits, ratio,
      burnRate, burnVelocity,
      fhTteSec, sdTteSec,
      contextPercent,
      peakActive,
    },
    baselines,
  };
}

function selectAction({
  fhTteSec, sdTteSec, peakActive, burnVelocity,
  modelName, ratio, edits, reads, contextPercent,
}) {
  // 1. Hard-stop
  if (fhTteSec !== null && fhTteSec > 0 && fhTteSec < HARD_STOP_5H_SEC) {
    return {
      tier: 'hard_stop_5h',
      signal: 'throttle',
      action: 'stop now — 5h window exhausting in <30 min',
      causalReason: `5h TTE ${formatMin(fhTteSec)} (peak-weighted)`,
    };
  }
  if (sdTteSec !== null && sdTteSec > 0 && sdTteSec < HARD_STOP_7D_SEC) {
    return {
      tier: 'hard_stop_7d',
      signal: 'throttle',
      action: 'stop session — 7d budget exhausting in <12h',
      causalReason: `7d TTE ${formatHours(sdTteSec)}`,
    };
  }

  // 2. Model swap (Opus → Sonnet) when burning hot during peak
  if (peakActive
      && burnVelocity !== null
      && burnVelocity > MODEL_SWAP_VELOCITY_X
      && /opus/i.test(modelName)) {
    return {
      tier: 'model_swap',
      signal: 'reduce',
      action: 'swap Opus → Sonnet (peak burn high)',
      causalReason: `peak active, burn ${burnVelocity.toFixed(1)}× your P50`,
    };
  }

  // 3. /clear — R:E ratio collapse
  if (edits >= RE_MIN_EDITS_FOR_SIGNAL && ratio < RE_DEGRADED_THRESHOLD) {
    return {
      tier: 'clear_session',
      signal: 'reduce',
      action: '/clear — model attention degraded (compact won\'t fix)',
      causalReason: `R:E ${ratio.toFixed(1)} (${reads}R/${edits}E) — read-before-edit pattern broken`,
    };
  }

  // 4. /compact — context pressure
  if (contextPercent !== null && contextPercent > COMPACT_CONTEXT_PCT) {
    return {
      tier: 'compact_context',
      signal: 'reduce',
      action: '/compact — context > 60%',
      causalReason: `context ${Math.round(contextPercent)}% used`,
    };
  }

  // 5. on track
  return {
    tier: 'ok',
    signal: 'increase',
    action: 'on track — proceed',
    causalReason: causalForOk({ peakActive, burnVelocity, ratio, edits, contextPercent }),
  };
}

function causalForOk({ peakActive, burnVelocity, ratio, edits, contextPercent }) {
  const parts = [];
  if (contextPercent !== null) parts.push(`ctx ${Math.round(contextPercent)}%`);
  if (edits >= RE_MIN_EDITS_FOR_SIGNAL) parts.push(`R:E ${ratio.toFixed(1)}`);
  if (burnVelocity !== null) parts.push(`burn ${burnVelocity.toFixed(1)}×P50`);
  if (peakActive) parts.push('peak');
  return parts.length ? parts.join(', ') : 'no signals tripped';
}

function computeConfidence(tokenStats) {
  const dur = Number(tokenStats?.durationMin ?? 0);
  const turns = Array.isArray(tokenStats?.recentTurnsOutput)
    ? tokenStats.recentTurnsOutput.length
    : 0;

  if (dur < CONFIDENCE_MIN_DURATION_LOW || turns < CONFIDENCE_MIN_TURNS_LOW) {
    return { level: 'low', why: `${Math.round(dur)}min / ${turns} turns` };
  }
  if (dur < CONFIDENCE_MIN_DURATION_MED || turns < CONFIDENCE_MIN_TURNS_MED) {
    return { level: 'medium', why: `${Math.round(dur)}min / ${turns} turns` };
  }
  return { level: 'high', why: `${Math.round(dur)}min / ${turns} turns` };
}

function formatMin(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}

function formatHours(sec) {
  const h = Math.max(0, Math.round(sec / 3600));
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}
