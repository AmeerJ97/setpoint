/**
 * Session cost estimator using API-equivalent pricing.
 * Gives a relative cost signal even on a Pro/Max subscription.
 *
 * Pricing is loaded from config/defaults.json (or the override at
 * CLAUDE_OPS_PRICING_FILE) keyed by model ID. Unknown named models do not
 * silently fall back to the default model; callers get a zero-priced row with
 * known=false so the HUD can render price:unknown instead of fake cost.
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
 *   4. Default model only when modelName is omitted
 *
 * @param {string} [modelName]
 * @returns {{ input:number, output:number, cacheCreate5m:number, cacheCreate1h:number, cacheRead:number, cacheCreate:number, known:boolean, modelId:string|null, source?:string|null, retrievedAt?:string|null }}
 */
export function resolvePricing(modelName) {
  const { defaultModel, models } = getPricing();

  const picked = pickRow(models, defaultModel, modelName);
  return normalizeRow(picked.row, picked);
}

function pickRow(models, defaultModel, modelName) {
  if (!modelName) {
    const row = models[defaultModel] ?? firstRowOrZero(models).row;
    return { row, known: Boolean(row), modelId: defaultModel ?? null, fallback: 'default' };
  }

  const normalized = normalizeModelKey(modelName);

  if (models[normalized]) return { row: models[normalized], known: true, modelId: normalized };
  if (models[modelName]) return { row: models[modelName], known: true, modelId: modelName };

  for (const key of Object.keys(models)) {
    const normalizedKey = normalizeModelKey(key);
    if (normalized.includes(normalizedKey) || normalizedKey.includes(normalized)) {
      return { row: models[key], known: true, modelId: key };
    }
  }

  return { row: zeroRow(), known: false, modelId: normalized, fallback: 'unknown' };
}

function normalizeModelKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function normalizeRow(row, meta = {}) {
  const safe = row ?? zeroRow();
  const cacheCreate5m = safe.cacheCreate5m ?? safe.cacheCreate ?? 0;
  const cacheCreate1h = safe.cacheCreate1h ?? cacheCreate5m * 1.6;
  return {
    input: safe.input ?? 0,
    output: safe.output ?? 0,
    cacheCreate5m,
    cacheCreate1h,
    cacheCreate: cacheCreate5m,
    cacheRead: safe.cacheRead ?? 0,
    known: meta.known !== false,
    modelId: meta.modelId ?? null,
    source: safe.source ?? safe.sourceUrl ?? null,
    retrievedAt: safe.retrievedAt ?? safe.retrieved_at ?? null,
    fallback: meta.fallback ?? null,
  };
}

function firstRowOrZero(models) {
  const k = Object.keys(models)[0];
  if (k) return { row: models[k], key: k };
  return { row: zeroRow(), key: null };
}

function zeroRow() {
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
 * Estimate API-billable session cost from token counters.
 *
 * Unlike calculateCost(), this includes prompt-cache reads and writes,
 * because API/Console/Gateway/cloud-provider sessions are cost-metered.
 * When cache TTL splits are available, 1h writes use the 1h rate and
 * remaining cache writes use the 5m rate. When only the legacy aggregate
 * cache-create counter exists, it is treated as 5m writes.
 *
 * @param {object} stats
 * @param {number} [stats.totalInput=0]
 * @param {number} [stats.totalOutput=0]
 * @param {number} [stats.totalCacheCreate=0]
 * @param {number} [stats.totalCacheCreate5m=0]
 * @param {number} [stats.totalCacheCreate1h=0]
 * @param {number} [stats.totalCacheRead=0]
 * @param {string} [modelName]
 * @returns {number} estimated API-billable USD cost
 */
export function calculateBillableCost(stats, modelName) {
  if (!stats) return 0;
  const p = resolvePricing(modelName);
  const mult = getDataResidencyMultiplier();

  const input = (stats.totalInput ?? 0) / 1_000_000 * p.input * mult;
  const output = (stats.totalOutput ?? 0) / 1_000_000 * p.output * mult;

  const split5m = Number(stats.totalCacheCreate5m ?? 0);
  const split1h = Number(stats.totalCacheCreate1h ?? 0);
  const aggregateCreate = Number(stats.totalCacheCreate ?? 0);
  const hasSplit = split5m > 0 || split1h > 0;
  const create5mTokens = hasSplit ? split5m : aggregateCreate;
  const create1hTokens = hasSplit ? split1h : 0;

  const cacheCreate5m = create5mTokens / 1_000_000 * p.cacheCreate5m * mult;
  const cacheCreate1h = create1hTokens / 1_000_000 * p.cacheCreate1h * mult;
  const cacheRead = (stats.totalCacheRead ?? 0) / 1_000_000 * p.cacheRead * mult;

  return input + output + cacheCreate5m + cacheCreate1h + cacheRead;
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
  // The RECENT_TURNS_TRACKED window is 12 turns. Use the lesser of the
  // full session duration and the estimated time that 12 turns would span
  // (capped at 30 min). This prevents turnsPerMin → 0 over long sessions,
  // which made ewmaBurnRate monotonically decay even at constant pace.
  // At 12 turns over 30 min = 0.4 turns/min; that's the floor, not
  // the ceiling — fast sessions will still show true rate.
  const RECENT_WINDOW_CAP_MIN = 30;
  const recentWindowMin = Math.min(durationMin, RECENT_WINDOW_CAP_MIN);
  const turnsPerMin = recentTurnsOutput.length / Math.max(1, recentWindowMin);
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
