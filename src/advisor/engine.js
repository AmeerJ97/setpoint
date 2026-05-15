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
import { predictProba, featuresFromMetrics } from './classifier.js';

/**
 * @typedef {object} Recommendation
 * @property {'increase'|'nominal'|'reduce'|'throttle'|'limit_hit'} signal
 * @property {string} action            - short imperative the user should take
 * @property {string} causalReason      - one-line "why" the user can verify
 * @property {'low'|'med'|'high'} confidence
 * @property {string} confidenceWhy     - one-line "why this confidence"
 * @property {string} tier              - which ladder rung fired (id, not text)
 * @property {string|null} backend
 * @property {string|null} telemetryAuthority
 * @property {object|null} syntheticTelemetry
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
 * @property {'max'|'api'|'bedrock'|'unknown'} [mode]  - session mode; demotes confidence when not 'max'
 * @property {import('../data/mode.js').RuntimeMode|null} [runtimeMode]
 * @property {object|null} [syntheticTelemetry]
 */

/**
 * Build a Recommendation from current session signals + historical baselines.
 *
 * @param {EngineInput} input
 * @returns {Recommendation}
 */
export function buildRecommendation(input) {
  const baselines = computeBaselines(input.history ?? []);
  const runtimeMode = input.runtimeMode ?? null;
  const backend = runtimeMode?.backend ?? null;
  const telemetryAuthority = runtimeMode?.telemetryAuthority ?? null;
  const syntheticTelemetry = input.syntheticTelemetry ?? null;
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

  const invalidAuthoritativeVertexCost = hasInvalidAuthoritativeVertexCostTelemetry(syntheticTelemetry);

  const confidence = computeConfidence(input.tokenStats, input.mode ?? 'max', baselines, input.apiWindowRefs ?? null, {
    backend,
    syntheticTelemetry,
    invalidAuthoritativeVertexCost,
  });

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
    mode: input.mode ?? 'max',
    apiWindowRefs: input.apiWindowRefs ?? null,
    backend,
    syntheticTelemetry,
    invalidAuthoritativeVertexCost,
  });

  // Limit-hit overrides everything except hard-stop wording — surface
  // it as the canonical signal so the display layer keeps its hit-state
  // colors / glyphs.
  const limitHit = fhDetail?.level === 'hit' || sdDetail?.level === 'hit';
  const finalSignal = limitHit ? 'limit_hit' : decision.signal;

  // Logistic-regression classifier — advisory only. The trained model
  // at src/advisor/classifier.js emits a probability over
  // {healthy, watch, risk}. If rules say "healthy" but the classifier
  // disagrees strongly (risk > 0.7) we demote the confidence from
  // high → med so the HUD visually signals uncertainty — the rule-
  // derived action is never rewritten.
  const reversalsPer1k = Number(input.tokenStats?.reversalsPer1k ?? 0);
  const classifier = predictProba(featuresFromMetrics({
    ratio, burnVelocity: burnVelocity ?? 1.0, contextPercent, reversalsPer1k,
  }));
  let adjustedConfidence = confidence.level;
  let confidenceWhy = confidence.why;
  if (
    classifier &&
    classifier.probabilities.risk > 0.7 &&
    (finalSignal === 'increase' || finalSignal === 'nominal') &&
    adjustedConfidence === 'high'
  ) {
    adjustedConfidence = 'med';
    confidenceWhy = `LR-classifier disagrees (risk=${classifier.probabilities.risk.toFixed(2)})`;
  }

  return {
    signal: finalSignal,
    action: limitHit ? 'wait for window reset' : decision.action,
    causalReason: limitHit
      ? `${fhDetail?.level === 'hit' ? '5h' : '7d'} window at 100%`
      : decision.causalReason,
    confidence: adjustedConfidence,
    confidenceWhy,
    tier: limitHit ? 'limit_hit' : decision.tier,
    backend,
    telemetryAuthority,
    syntheticTelemetry,
    metrics: {
      reads, edits, ratio,
      burnRate, burnVelocity,
      fhTteSec, sdTteSec,
      contextPercent,
      peakActive,
      reversalsPer1k,
    },
    baselines,
    classifier,  // exposed for HUD salience + drilldown; null if weights missing
  };
}

function selectAction({
  fhTteSec, sdTteSec, peakActive, burnVelocity,
  modelName, ratio, edits, reads, contextPercent,
  mode, apiWindowRefs, backend, syntheticTelemetry,
  invalidAuthoritativeVertexCost,
}) {
  const isApi = mode === 'api' || mode === 'unknown';
  const isVertex = backend === 'vertex-ai';

  if (isVertex) {
    const telemetryAuthority = syntheticTelemetry?.telemetryAuthority ?? 'local-synthetic';
    const apiBacked = telemetryAuthority === 'vertex-api';
    const metricsBacked = telemetryAuthority === 'vertex-metrics-estimate';

    if (syntheticTelemetry?.signal === 'limit_hit') {
      return {
        tier: 'vertex_quota_exhausted',
        signal: 'limit_hit',
        action: 'pause Vertex traffic or switch region/project',
        causalReason: syntheticTelemetry?.causalReason
          ? `${syntheticTelemetry.causalReason} from Vertex telemetry`
          : 'GCP_QUOTA_EXHAUSTED from Vertex telemetry',
      };
    }

    if (metricsBacked) {
      return {
        tier: 'vertex_metrics_only',
        signal: 'throttle',
        action: 'Vertex token metrics only — verify billing export before scaling',
        causalReason: 'Vertex token metrics lack provider-authoritative cost source',
      };
    }

    if (!apiBacked || syntheticTelemetry?.missingApiTelemetry) {
      return {
        tier: 'vertex_api_missing',
        signal: 'throttle',
        action: 'Vertex API telemetry missing — throttle and verify billing source',
        causalReason: syntheticTelemetry?.apiTelemetryReason
          ?? 'local synthetic telemetry only; set CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE',
      };
    }

    if (invalidAuthoritativeVertexCost) {
      return {
        tier: 'vertex_api_invalid_cost',
        signal: 'throttle',
        action: 'Vertex API cost payload invalid — throttle and verify billing fields',
        causalReason: 'authoritative Vertex snapshot has nonzero tokens but nonpositive cost_usd',
      };
    }

    if (hasUninformativeAuthoritativeVertexUsageTelemetry(syntheticTelemetry)) {
      return {
        tier: 'vertex_api_missing',
        signal: 'throttle',
        action: 'Vertex API telemetry has no measurable usage — throttle and verify billing export',
        causalReason: 'authoritative Vertex snapshot reports zero total_tokens across windows',
      };
    }

    if (burnVelocity !== null && burnVelocity > 2.0) {
      return {
        tier: 'vertex_burn_high',
        signal: 'reduce',
        action: 'Vertex burn hot — reduce concurrency or swap to Sonnet',
        causalReason: `authoritative Vertex burn ${burnVelocity.toFixed(1)}× your P50`,
      };
    }
  }

  if (!isApi && !isVertex) {
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
  } else {
    // API Mode overrides: replace TTE hard-stops with burn/cost risk.
    if (burnVelocity !== null && burnVelocity > 2.5) {
      return {
        tier: 'api_burn_high',
        signal: 'reduce',
        action: 'API burn hot — swap to Sonnet',
        causalReason: `burn ${burnVelocity.toFixed(1)}× your P50`,
      };
    }
    if (apiWindowRefs?.dataMaturity?.state === 'local_reference'
        && apiWindowRefs?.ref7dCostUsd
        && apiWindowRefs.sessionCostPct7d > 90) {
      return {
        tier: 'api_weekly_ref_high',
        signal: 'reduce',
        action: 'session cost above local 7d reference',
        causalReason: `session ${Math.round(apiWindowRefs.sessionCostPct7d)}% of local 7d spend ref`,
      };
    }
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

function hasInvalidAuthoritativeVertexCostTelemetry(syntheticTelemetry) {
  const telemetryAuthority = syntheticTelemetry?.telemetryAuthority ?? null;
  if (telemetryAuthority !== 'vertex-api') return false;

  const windows = [syntheticTelemetry?.fiveHour, syntheticTelemetry?.sevenDay];
  return windows.some((win) => {
    if (!win || typeof win !== 'object') return false;
    const totalTokens = Number(win.totalTokens);
    const costUsd = Number(win.costUsd);
    if (!Number.isFinite(costUsd)) return false;
    if (costUsd < 0) return true;
    return Number.isFinite(totalTokens) && totalTokens > 0 && costUsd <= 0;
  });
}

function hasUninformativeAuthoritativeVertexUsageTelemetry(syntheticTelemetry) {
  const telemetryAuthority = syntheticTelemetry?.telemetryAuthority ?? null;
  if (telemetryAuthority !== 'vertex-api') return false;

  const windows = [syntheticTelemetry?.fiveHour, syntheticTelemetry?.sevenDay]
    .filter(win => win && typeof win === 'object');
  if (windows.length === 0) return true;
  return windows.every((win) => {
    const totalTokens = Number(win.totalTokens);
    return Number.isFinite(totalTokens) && totalTokens <= 0;
  });
}

function causalForOk({ peakActive, burnVelocity, ratio, edits, contextPercent }) {
  const parts = [];
  if (contextPercent !== null) parts.push(`ctx ${Math.round(contextPercent)}%`);
  if (edits >= RE_MIN_EDITS_FOR_SIGNAL) parts.push(`R:E ${ratio.toFixed(1)}`);
  if (burnVelocity !== null) parts.push(`burn ${burnVelocity.toFixed(1)}×P50`);
  if (peakActive) parts.push('peak');
  return parts.length ? parts.join(', ') : 'no signals tripped';
}

function computeConfidence(tokenStats, mode, baselines, apiWindowRefs = null, {
  backend = null,
  syntheticTelemetry = null,
  invalidAuthoritativeVertexCost = false,
} = {}) {
  const dur = Number(tokenStats?.durationMin ?? 0);
  const turns = Array.isArray(tokenStats?.recentTurnsOutput)
    ? tokenStats.recentTurnsOutput.length
    : 0;

  if (backend === 'vertex-ai') {
    const telemetryAuthority = syntheticTelemetry?.telemetryAuthority ?? 'local-synthetic';
    const apiBacked = telemetryAuthority === 'vertex-api';
    const metricsBacked = telemetryAuthority === 'vertex-metrics-estimate';

    if (syntheticTelemetry?.signal === 'limit_hit' && apiBacked) {
      return {
        level: 'high',
        why: 'Vertex API telemetry reported quota exhaustion',
      };
    }
    if (syntheticTelemetry?.signal === 'limit_hit') {
      return {
        level: 'med',
        why: 'Vertex quota exhaustion detected from local evidence (non-authoritative totals)',
      };
    }

    if (metricsBacked) {
      return {
        level: 'med',
        why: 'Vertex AI — token metrics active, billing source missing',
      };
    }

    if (!apiBacked || syntheticTelemetry?.missingApiTelemetry) {
      return {
        level: 'low',
        why: syntheticTelemetry?.apiTelemetryReason
          ?? 'Vertex AI — synthetic local telemetry only; authoritative API snapshot missing',
      };
    }

    if (invalidAuthoritativeVertexCost) {
      return {
        level: 'low',
        why: 'Vertex AI — authoritative API snapshot has nonpositive or negative cost_usd',
      };
    }

    if (hasUninformativeAuthoritativeVertexUsageTelemetry(syntheticTelemetry)) {
      return {
        level: 'low',
        why: 'Vertex AI — authoritative API snapshot reports zero total_tokens across windows',
      };
    }

    if (dur >= CONFIDENCE_MIN_DURATION_MED && turns >= CONFIDENCE_MIN_TURNS_MED) {
      return {
        level: 'high',
        why: 'Vertex AI — authoritative API telemetry active',
      };
    }
    if (dur >= CONFIDENCE_MIN_DURATION_LOW && turns >= CONFIDENCE_MIN_TURNS_LOW) {
      return {
        level: 'med',
        why: 'Vertex AI — API telemetry active; session still warming',
      };
    }
    return {
      level: 'low',
      why: 'Vertex AI — API telemetry active; insufficient session signal',
    };
  }

  const hasRateLimitData = mode === 'max';
  if (!hasRateLimitData) {
    const maturity = apiWindowRefs?.dataMaturity;
    if (maturity?.state === 'local_reference'
        && dur >= CONFIDENCE_MIN_DURATION_MED
        && turns >= CONFIDENCE_MIN_TURNS_MED) {
      return { level: 'med', why: 'API mode — mature local cost reference, no quota data' };
    }
    return {
      level: 'low',
      why: maturity?.reason ?? 'API mode — no rate-limit window data',
    };
  }

  if (dur < CONFIDENCE_MIN_DURATION_LOW || turns < CONFIDENCE_MIN_TURNS_LOW) {
    return { level: 'low', why: `${Math.round(dur)}min / ${turns} turns` };
  }
  if (dur < CONFIDENCE_MIN_DURATION_MED || turns < CONFIDENCE_MIN_TURNS_MED) {
    return { level: 'med', why: `${Math.round(dur)}min / ${turns} turns` };
  }
  if (!baselines?.sufficient) {
    return { level: 'med', why: 'personal baselines warming up' };
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
