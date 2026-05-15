/**
 * API mode analytics — cost-based window references for sessions running
 * against the raw Anthropic API (ANTHROPIC_API_KEY set, no rate_limits).
 *
 * When rate_limits are absent, the 5h/7d rolling-window gauges have no
 * native data source. This module derives reference cost values from the
 * local usage history so the Usage and Advisor lines can still show
 * meaningful gauges:
 *
 *   "This session has an estimated API billable cost of ~$1.24 so far.
 *    A typical 5h window (from your history) costs ~$2.80."
 *
 * Both values are local estimates expressed in USD at current model pricing
 * so the ratio is directly comparable even when switching between models.
 *
 * @module src/analytics/api-cost
 */

import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';
import { getTelemetryTuning } from '../data/defaults.js';
import { calculateBillableCost, resolvePricing } from './cost.js';

const FIVE_HOUR_MS  = 5  * 3600 * 1000;
const SEVEN_DAY_MS  = 7  * 86400 * 1000;
const THIRTY_DAY_MS = 30 * 86400 * 1000;

/**
 * @typedef {object} ApiWindowRef
 * @property {number}      sessionCostUsd      - current API billable-estimate cost in USD
 * @property {number|null} ref5hCostUsd        - typical 5h window cost (from history)
 * @property {number|null} ref7dCostUsd        - typical 7d total cost (from history)
 * @property {number}      sessionCostPct5h    - sessionCostUsd / ref5hCostUsd × 100 (0–100+)
 * @property {number}      sessionCostPct7d    - similar for 7d
 * @property {number}      historySamples      - number of history entries used
 * @property {{ state: 'cold_start'|'warming'|'local_reference', reason: string, samples: number, distinctSessions: number }} dataMaturity
 * @property {'ok'|'watch'|'tight'|'critical'} level5h
 * @property {'ok'|'watch'|'tight'|'critical'} level7d
 */

/**
 * Compute API-mode window references from history + current session stats.
 *
 * @param {object} tokenStats  - augmented token stats from hud/renderer.js
 * @param {string} [modelName] - model display name or ID for pricing lookup
 * @param {object[]} [history] - injected history (tests); reads from disk otherwise
 * @param {{ currentSessionId?: string|null, now?: number, nativeSessionCostUsd?: number|null, nativeCostAuthority?: string|null }} [options]
 * @returns {ApiWindowRef}
 */
export function computeApiWindowRefs(tokenStats, modelName, history, options = {}) {
  const pricing = resolvePricing(modelName);
  const nativeCost = finite(options.nativeSessionCostUsd);
  const sessionCostUsd = nativeCost ?? calculateBillableCost(tokenStats, modelName);
  const sessionCostAuthority = nativeCost == null ? 'local-estimate' : (options.nativeCostAuthority ?? 'statusline-cost');

  const hist = history ?? safeReadHistory();

  const { ref5h, ref7d, samples, maturity } = computeRefCosts(hist, options);

  const sessionCostPct5h = ref5h && ref5h > 0
    ? Math.min(150, (sessionCostUsd / ref5h) * 100)
    : 0;
  const sessionCostPct7d = ref7d && ref7d > 0
    ? Math.min(150, (sessionCostUsd / ref7d) * 100)
    : 0;

  return {
    sessionCostUsd,
    ref5hCostUsd: ref5h,
    ref7dCostUsd: ref7d,
    sessionCostPct5h,
    sessionCostPct7d,
    historySamples: samples,
    dataMaturity: maturity,
    level5h: classifyLevel(sessionCostPct5h),
    level7d: classifyLevel(sessionCostPct7d),
    sessionCostAuthority,
    pricingKnown: pricing.known,
    pricingModelId: pricing.modelId,
  };
}

/**
 * Derive approximate reference costs from usage history.
 *
 * For ref5h: take all history entries with API billable-estimate
 * `session_cost_usd` over the last 30 days, group them into approximate 5h windows by binning
 * timestamps, then average the per-window totals.
 * Falls back to burn-rate extrapolation if cost field is missing (legacy entries).
 *
 * For ref7d: sum API billable-estimate `session_cost_usd` across the
 * last 7 days. This is a local spend reference, not an account limit.
 *
 * @param {object[]} history
 * @returns {{ ref5h: number|null, ref7d: number|null, samples: number }}
 */
function computeRefCosts(history, { currentSessionId = null, now = Date.now() } = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return {
      ref5h: null,
      ref7d: null,
      samples: 0,
      maturity: maturity('cold_start', 'no local API billable history yet', 0, 0),
    };
  }

  const cutoff30d = now - THIRTY_DAY_MS;
  const cutoff7d  = now - SEVEN_DAY_MS;

  // Entries with API billable-estimate cost data (new schema). Older
  // generation-only cost rows are intentionally ignored here so API-mode
  // references do not mix incompatible meanings.
  const withCost = history.filter(e => {
    const ts = Date.parse(e.ts);
    return ts >= cutoff30d
      && e.cost_kind === 'api_billable_estimate'
      && typeof e.session_cost_usd === 'number'
      && e.session_cost_usd > 0
      && (!currentSessionId || e.session_id !== currentSessionId);
  });

  const samples = withCost.length;
  const distinctSessions = new Set(withCost.map(e => e.session_id).filter(Boolean)).size;
  const oldestTs = withCost.reduce((min, e) => Math.min(min, Date.parse(e.ts)), Infinity);
  const oldestAgeMinutes = Number.isFinite(oldestTs) ? (now - oldestTs) / 60_000 : 0;
  const tuning = getTelemetryTuning().apiRefs;
  const mature = samples >= tuning.minSamples
    && distinctSessions >= tuning.minDistinctSessions
    && oldestAgeMinutes >= tuning.minOldestAgeMinutes;
  const maturityState = mature
    ? maturity('local_reference', 'local API cost reference is mature enough for comparison', samples, distinctSessions)
    : maturity('warming', warmingReason({ samples, distinctSessions, oldestAgeMinutes, tuning }), samples, distinctSessions);

  if (!mature) {
    return { ref5h: null, ref7d: null, samples, maturity: maturityState };
  }

  // --- ref5h: average cost of a 5-hour window ---
  // Bin entries into 5h buckets relative to the current render time.
  // Using a relative window avoids boundary sensitivity when now aligns near
  // global epoch boundaries (Date.now() +/- 5h drift).
  const buckets5h = new Map();
  for (const e of withCost) {
    const ts = Date.parse(e.ts);
    if (ts > now) continue;
    const bucket = Math.floor((now - ts) / FIVE_HOUR_MS);
    buckets5h.set(bucket, (buckets5h.get(bucket) ?? 0) + e.session_cost_usd);
  }

  let ref5h = null;
  if (buckets5h.size > 0) {
    const vals = Array.from(buckets5h.values());
    ref5h = vals.reduce((a, b) => a + b, 0) / vals.length;
    // Clamp to a reasonable range — less than $0.01 means the history is
    // all tiny test sessions; more than $50 per 5h is implausibly high.
    if (ref5h < 0.01) ref5h = null;
    if (ref5h > 50) ref5h = 50;
  }

  // --- ref7d: total spend in the last 7 days ---
  let ref7d = null;
  const entries7d = withCost.filter(e => Date.parse(e.ts) >= cutoff7d);
  if (entries7d.length > 0) {
    ref7d = entries7d.reduce((a, e) => a + e.session_cost_usd, 0);
    if (ref7d < 0.01) ref7d = null;
  }
  return { ref5h, ref7d, samples, maturity: maturityState };
}

function maturity(state, reason, samples, distinctSessions) {
  return { state, reason, samples, distinctSessions };
}

function warmingReason({ samples, distinctSessions, oldestAgeMinutes, tuning }) {
  const missing = [];
  if (samples < tuning.minSamples) missing.push(`${samples}/${tuning.minSamples} samples`);
  if (distinctSessions < tuning.minDistinctSessions) {
    missing.push(`${distinctSessions}/${tuning.minDistinctSessions} sessions`);
  }
  if (oldestAgeMinutes < tuning.minOldestAgeMinutes) {
    missing.push(`${Math.floor(oldestAgeMinutes)}/${tuning.minOldestAgeMinutes} min span`);
  }
  return `warming local API reference (${missing.join(', ')})`;
}

/**
 * Classify cost percentage into a risk level, mirroring the Max-mode
 * classifyLevel thresholds so colors are consistent across modes.
 * @param {number} pct
 * @returns {'ok'|'watch'|'tight'|'critical'}
 */
function classifyLevel(pct) {
  if (pct > 90) return 'critical';
  if (pct > 70) return 'tight';
  if (pct > 50) return 'watch';
  return 'ok';
}

/**
 * Format a USD cost for the Usage line. Always prefixes with `~` to
 * indicate these are estimates, not billing figures.
 * @param {number|null} cost
 * @returns {string}
 */
export function formatApiCost(cost) {
  if (cost == null || !Number.isFinite(cost)) return '--';
  if (cost >= 10)  return `~$${cost.toFixed(0)}`;
  if (cost >= 1)   return `~$${cost.toFixed(1)}`;
  if (cost >= 0.01) return `~$${cost.toFixed(2)}`;
  return '<$0.01';
}

function finite(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function safeReadHistory() {
  try { return readJsonlWindow(HISTORY_FILE, THIRTY_DAY_MS); }
  catch { return []; }
}
