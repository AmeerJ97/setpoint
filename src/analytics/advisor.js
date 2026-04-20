/**
 * Advisor adapter — thin wrapper over `src/advisor/engine.js` that
 * preserves the existing `Advisory` shape the HUD renderer consumes
 * while threading the engine's new Recommendation fields through.
 *
 * The engine is the source of truth for `signal`, `action`, `confidence`,
 * `causalReason`, `metrics`, and `baselines`. Window-level fields
 * (`fiveHour`, `sevenDay`) come straight from the rate engine — the
 * advisor doesn't add anything to them, just hands them to the display.
 */

import { buildRecommendation } from '../advisor/engine.js';
import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';

/**
 * @typedef {object} Advisory
 * @property {'increase'|'nominal'|'reduce'|'throttle'|'limit_hit'} signal
 * @property {string} reason            - kept for backward compat (= causalReason)
 * @property {string} action
 * @property {string} causalReason
 * @property {'low'|'medium'|'high'} confidence
 * @property {string} confidenceWhy
 * @property {string} tier
 * @property {{ effort: string, model: string }} suggestion
 * @property {import('./rates.js').WindowProjection|null} fiveHour
 * @property {import('./rates.js').WindowProjection|null} sevenDay
 * @property {number} burnRate
 * @property {'low'|'medium'|'high'} burnLevel
 * @property {number} estimatedSessions
 * @property {object} metrics
 * @property {object} baselines
 */

const HISTORY_WINDOW_MS = 30 * 86_400_000; // 30 days for baselining

/**
 * @param {import('./rates.js').RateData} rates
 * @param {import('../data/stdin.js').UsageData|null} usageData
 * @param {object} [options]
 * @param {Record<string, number>} [options.toolCounts]
 * @param {{ burnRate?: number, durationMin?: number, recentTurnsOutput?: number[] }} [options.tokenStats]
 * @param {number|null} [options.contextPercent]
 * @param {string|null} [options.modelName]
 * @param {Array<object>} [options.history]    - inject history (tests); else read from disk
 * @returns {Advisory}
 */
export function computeAdvisory(rates, usageData, options = {}) {
  const fiveHour = rates?.fiveHourDetail ?? null;
  const sevenDay = rates?.sevenDayDetail ?? null;
  const burn = Number(rates?.burnRate ?? 0);
  const sessions = rates?.estimatedSessions ?? 1;

  const history = options.history ?? safeReadHistory();

  const rec = buildRecommendation({
    rates,
    usage: usageData,
    tokenStats: options.tokenStats ?? { burnRate: burn },
    toolCounts: options.toolCounts ?? {},
    contextPercent: options.contextPercent ?? null,
    modelName: options.modelName ?? null,
    history,
  });

  return {
    signal: rec.signal,
    reason: rec.causalReason,
    action: rec.action,
    causalReason: rec.causalReason,
    confidence: rec.confidence,
    confidenceWhy: rec.confidenceWhy,
    tier: rec.tier,
    suggestion: deriveSuggestion(rec),
    fiveHour, sevenDay,
    burnRate: burn,
    burnLevel: classifyBurn(burn),
    estimatedSessions: sessions,
    metrics: rec.metrics,
    baselines: rec.baselines,
  };
}

function deriveSuggestion(rec) {
  // Map the engine's tier into the legacy {effort, model} hint that the
  // daily report and one or two display callers still read. Conservative
  // defaults — when the engine says "throttle" we always step down.
  switch (rec.tier) {
    case 'hard_stop_5h':
    case 'hard_stop_7d':
    case 'limit_hit':
      return { effort: 'low', model: 'sonnet' };
    case 'model_swap':
      return { effort: 'high', model: 'sonnet' };
    case 'clear_session':
    case 'compact_context':
      return { effort: 'medium', model: 'opus' };
    default:
      return { effort: 'high', model: 'opus' };
  }
}

function classifyBurn(rate) {
  if (rate > 1000) return 'high';
  if (rate > 400) return 'medium';
  return 'low';
}

function safeReadHistory() {
  try { return readJsonlWindow(HISTORY_FILE, HISTORY_WINDOW_MS); }
  catch { return []; }
}
