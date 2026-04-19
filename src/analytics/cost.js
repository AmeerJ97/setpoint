/**
 * Session cost estimator using API-equivalent pricing.
 * Gives a relative cost signal even on a Pro/Max subscription.
 *
 * Pricing is loaded from config/defaults.json (or the override at
 * CLAUDE_HUD_PRICING_FILE) keyed by model ID. Unknown models fall back
 * to the configured defaultModel. Prices are USD per 1M tokens.
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
 * @returns {{ input:number, output:number, cacheCreate:number, cacheRead:number }}
 */
export function resolvePricing(modelName) {
  const { defaultModel, models } = getPricing();

  if (!modelName) return models[defaultModel] ?? firstRowOrZero(models);

  const normalized = String(modelName).toLowerCase().replace(/\s+/g, '-');

  if (models[normalized]) return models[normalized];
  if (models[modelName]) return models[modelName];

  for (const key of Object.keys(models)) {
    if (normalized.includes(key) || key.includes(normalized)) return models[key];
  }

  return models[defaultModel] ?? firstRowOrZero(models);
}

function firstRowOrZero(models) {
  const k = Object.keys(models)[0];
  if (k) return models[k];
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
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
  const input  = (stats.totalInput  ?? 0) / 1_000_000 * p.input;
  const output = (stats.totalOutput ?? 0) / 1_000_000 * p.output;
  return input + output;
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
