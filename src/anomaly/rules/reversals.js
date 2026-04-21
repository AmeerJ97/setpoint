/**
 * Reasoning-reversals anomaly rule.
 *
 * "Reversals" are the phrases in the assistant's own output that mark a
 * hypothesis retraction — "wait,", "actually,", "never mind,", etc. A high
 * reversals-per-1k-tool-calls rate is the same signal the daily advisor
 * already flags: the model is thrashing on its own output instead of
 * converging.
 *
 * The rule fires `warn` when the session's rate exceeds the daily advisor's
 * threshold (25 / 1k calls). It's intentionally stateless — the renderer
 * pre-computes the rate from the live tool-call stream and passes it in.
 *
 * @param {object} data
 * @param {number} [data.reversalsPer1k] - reversals per 1000 tool calls (live session)
 * @param {number} [data.toolCallCount]  - absolute tool call count (used to squelch tiny samples)
 * @returns {{ triggered: boolean, message: string, severity: string, reversalsPer1k?: number }|null}
 */

// Same threshold the daily report flags at (see src/advisor/index.js
// `scanReversalsForActiveSessions`). Keeping it in one place would be
// cleaner; when a second caller needs it, promote to thresholds.js.
const REVERSALS_WARN_PER_1K = 25;
// Don't fire on micro-samples — a 1-reversal/10-call session is 100/1k
// but carries no signal.
const MIN_CALLS_FOR_SIGNAL = 40;

export function checkReversals(data) {
  const rate = Number(data?.reversalsPer1k);
  const calls = Number(data?.toolCallCount ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (calls < MIN_CALLS_FOR_SIGNAL) return null;

  if (rate >= REVERSALS_WARN_PER_1K) {
    return {
      triggered: true,
      message: `reversals ${rate.toFixed(1)}/1k — thrashing`,
      severity: 'warn',
      reversalsPer1k: rate,
      toolCallCount: calls,
    };
  }

  return null;
}

export const REVERSALS_THRESHOLDS = {
  WARN_PER_1K: REVERSALS_WARN_PER_1K,
  MIN_CALLS_FOR_SIGNAL,
};
