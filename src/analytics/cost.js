/**
 * Session cost estimator using API-equivalent pricing.
 * Gives a relative cost signal even on a Pro/Max subscription.
 *
 * Pricing is loaded from config/defaults.json (or the override at
 * CLAUDE_HUD_PRICING_FILE) keyed by model ID. Unknown models fall back
 * to the configured defaultModel. Prices are USD per 1M tokens.
 *
 * Pricing rows hold separate fields for 5-minute and 1-hour cache
 * writes (per Anthropic's published rates) plus cache_read. The
 * `cacheCreate` legacy alias falls back to `cacheCreate5m` for any
 * caller that hasn't migrated.
 */

import { getPricing } from '../data/defaults.js';

/**
 * Resolve a pricing row for the given model name. Matches:
 *   1. Exact key ("claude-opus-4-7")
 *   2. Display-name variants ("Opus 4.7" → "claude-opus-4-7")
 *   3. Any model key whose name appears as a substring of the input
 *   4. Fallback to defaultModel
 *
 * @param {string} [modelName]
 * @returns {{ input:number, output:number, cacheCreate5m:number, cacheCreate1h:number, cacheRead:number, cacheCreate:number }}
 */
export function resolvePricing(modelName) {
  const { defaultModel, models } = getPricing();

  const row = pickRow(models, defaultModel, modelName);
  return normalizeRow(row);
}

function pickRow(models, defaultModel, modelName) {
  if (!modelName) return models[defaultModel] ?? firstRowOrZero(models);

  const normalized = String(modelName).toLowerCase().replace(/\s+/g, '-');

  if (models[normalized]) return models[normalized];
  if (models[modelName]) return models[modelName];

  for (const key of Object.keys(models)) {
    if (normalized.includes(key) || key.includes(normalized)) return models[key];
  }

  return models[defaultModel] ?? firstRowOrZero(models);
}

function normalizeRow(row) {
  const cacheCreate5m = row.cacheCreate5m ?? row.cacheCreate ?? 0;
  const cacheCreate1h = row.cacheCreate1h ?? cacheCreate5m * 1.6;
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    cacheCreate5m,
    cacheCreate1h,
    cacheCreate: cacheCreate5m,
    cacheRead: row.cacheRead ?? 0,
  };
}

function firstRowOrZero(models) {
  const k = Object.keys(models)[0];
  if (k) return models[k];
  return { input: 0, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
}

/**
 * Per-MTok data-residency multiplier (1.1× when inference_geo=US is opted in,
 * Opus 4.5+ only). Default config value is 1.0 (off).
 * @returns {number}
 */
export function getDataResidencyMultiplier() {
  const { dataResidencyMultiplier } = getPricing();
  return Number.isFinite(dataResidencyMultiplier) ? dataResidencyMultiplier : 1.0;
}

/**
 * Calculate session cost from token counts.
 *
 * Only counts input + output tokens. Cache reads and cache writes are
 * excluded by design: on Max / Pro subscriptions you don't pay per
 * token, and cache_read is a cumulative counter (every turn re-reads
 * the entire cached context) that balloons into hundreds of dollars
 * for long sessions — producing a number that's arithmetically correct
 * against API billing but meaningless as a "what is this session
 * costing me" signal. What the user cares about is generation spend,
 * which is what input + output tracks.
 *
 * @param {object} stats
 * @param {number} [stats.totalInput=0]
 * @param {number} [stats.totalOutput=0]
 * @param {string} [modelName] - when omitted, uses pricing.defaultModel
 * @returns {number} cost in USD (generation only)
 */
export function calculateCost(stats, modelName) {
  if (!stats) return 0;
  const p = resolvePricing(modelName);
  const mult = getDataResidencyMultiplier();
  const input  = (stats.totalInput  ?? 0) / 1_000_000 * p.input  * mult;
  const output = (stats.totalOutput ?? 0) / 1_000_000 * p.output * mult;
  return input + output;
}

/**
 * Cost-relevance per-token weight for an active model. Used by burn-rate
 * calculations that want to express token throughput in $/min terms.
 * Returns USD/token (per single token, not per MTok).
 *
 * Weights:
 *   - input:        full input rate
 *   - output:       full output rate
 *   - cacheCreate:  uses 5m write rate (the conservative/common case)
 *   - cacheRead:    full cache read rate
 *
 * @param {string} [modelName]
 * @returns {{ input:number, output:number, cacheCreate:number, cacheRead:number }}
 */
export function perTokenWeights(modelName) {
  const p = resolvePricing(modelName);
  const mult = getDataResidencyMultiplier();
  return {
    input:       (p.input        * mult) / 1_000_000,
    output:      (p.output       * mult) / 1_000_000,
    cacheCreate: (p.cacheCreate5m * mult) / 1_000_000,
    cacheRead:   (p.cacheRead    * mult) / 1_000_000,
  };
}

/**
 * Cost-weighted burn rate, expressed as output-token-equivalent tokens
 * per minute so the existing `t/m` display unit still makes sense.
 *
 * Why not raw `output / minutes`? An assistant turn that prefills 100K
 * tokens of context but emits 50 tokens of output costs real quota
 * (the prefill is billed) yet shows ~zero burn under the old formula.
 * Cost-weighting reflects what the user actually pays for: input,
 * output, cache writes (5m tier), and cache reads — each scaled by
 * its per-MTok price for the active model.
 *
 * Returned in output-equivalent tokens/min by dividing total $-cost by
 * the output rate, so a session running purely on output behaves
 * identically to the old formula.
 *
 * @param {object} stats
 * @param {number} [stats.totalInput=0]
 * @param {number} [stats.totalOutput=0]
 * @param {number} [stats.totalCacheCreate=0]
 * @param {number} [stats.totalCacheRead=0]
 * @param {number} [stats.durationMin=0]
 * @param {string} [modelName]
 * @returns {number} output-token-equivalent tokens per minute (rounded)
 */
export function costWeightedBurnRate(stats, modelName) {
  if (!stats || !stats.durationMin || stats.durationMin <= 0) return 0;
  const w = perTokenWeights(modelName);
  if (!Number.isFinite(w.output) || w.output <= 0) {
    return Math.round((stats.totalOutput ?? 0) / stats.durationMin);
  }
  const totalCost =
      (stats.totalInput       ?? 0) * w.input +
      (stats.totalOutput      ?? 0) * w.output +
      (stats.totalCacheCreate ?? 0) * w.cacheCreate +
      (stats.totalCacheRead   ?? 0) * w.cacheRead;
  const equivOutputTokens = totalCost / w.output;
  return Math.round(equivOutputTokens / stats.durationMin);
}

/**
 * EWMA-smoothed burn rate from a per-turn output token series.
 * α=0.2 by default — single bursty turns shift the smoothed value by
 * 20% rather than dominating it. Returns 0 when the series is empty.
 *
 * The series itself is per-turn output tokens; we convert to per-min
 * by scaling against the recent-window duration (turns/min × ewma).
 * This is a useful proxy for "current burn" without needing per-turn
 * timestamps, which the daemon doesn't currently persist.
 *
 * @param {number[]} recentTurnsOutput
 * @param {number} durationMin - recent-window duration in minutes
 * @param {number} [alpha=0.2]
 * @returns {number} smoothed tokens per minute (rounded)
 */
export function ewmaBurnRate(recentTurnsOutput, durationMin, alpha = 0.2) {
  if (!Array.isArray(recentTurnsOutput) || recentTurnsOutput.length === 0) return 0;
  if (!durationMin || durationMin <= 0) return 0;
  let ewma = recentTurnsOutput[0];
  for (let i = 1; i < recentTurnsOutput.length; i++) {
    ewma = alpha * recentTurnsOutput[i] + (1 - alpha) * ewma;
  }
  const turnsPerMin = recentTurnsOutput.length / Math.max(1, durationMin);
  return Math.round(ewma * turnsPerMin);
}

/**
 * Format cost as string, prefixed with ~ to make the "reference not
 * bill" framing unambiguous.
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (cost >= 10)  return `~$${cost.toFixed(0)}`;
  if (cost >= 1)   return `~$${cost.toFixed(1)}`;
  return `~$${cost.toFixed(2)}`;
}
