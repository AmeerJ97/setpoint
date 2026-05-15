/**
 * Cache pathology checks — local, evidence-only detectors for sessions
 * where prompt-cache accounting or reuse looks unusual.
 */

const MIN_CACHE_TOKENS = 50_000;
const CACHE_HEAVY_RATIO = 0.85;
const LOW_REUSE_RATIO = 0.25;

/**
 * @param {object} data
 * @param {number} [data.inputTokens]
 * @param {number} [data.outputTokens]
 * @param {number} [data.cacheCreateTokens]
 * @param {number} [data.cacheReadTokens]
 * @param {number} [data.apiCalls]
 * @param {number} [data.compactionCount]
 * @param {number} [data.cchHashMutationCount]
 * @returns {Array<{triggered: boolean, type: string, severity: string, message: string}>}
 */
export function checkCachePathologies(data) {
  const alerts = [];
  const input = finite(data.inputTokens);
  const output = finite(data.outputTokens);
  const cacheCreate = finite(data.cacheCreateTokens);
  const cacheRead = finite(data.cacheReadTokens);
  const total = input + output + cacheCreate + cacheRead;
  const cacheTotal = cacheCreate + cacheRead;
  const apiCalls = finite(data.apiCalls);

  if (cacheTotal >= MIN_CACHE_TOKENS && total > 0 && cacheTotal / total >= CACHE_HEAVY_RATIO) {
    alerts.push(warn('cache-heavy-session', 'cache tokens dominate this session; API cost estimates may move faster than output tokens'));
  }

  if (cacheCreate >= MIN_CACHE_TOKENS && cacheRead / Math.max(1, cacheCreate) < LOW_REUSE_RATIO) {
    alerts.push(warn('cache-low-reuse', 'large cache writes with low cache-read reuse'));
  }

  if (apiCalls > 1 && cacheCreate >= MIN_CACHE_TOKENS && cacheRead === 0) {
    alerts.push(warn('cache-read-missing', 'cache writes observed but no cache reads after multiple API calls'));
  }

  if (finite(data.compactionCount) >= 3) {
    alerts.push(warn('auto-compact-burst', 'multiple compactions observed; cache and context history may be unstable'));
  }

  if (finite(data.cchHashMutationCount) > 0) {
    alerts.push(warn('transcript-cache-hash-marker', 'transcript contains cch= cache hash markers; inspect before trusting cache reuse'));
  }

  return alerts;
}

function warn(type, message) {
  return { triggered: true, type, severity: 'warn', message };
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}
