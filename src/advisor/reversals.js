/**
 * Reasoning-reversal counter — surfaces how often the model rewinds
 * its own conclusions inside a session. Per #42796 §3.7 evidence:
 * a healthy session has near-zero reversals; degraded model behavior
 * (the same R:E collapse documented in the bugs doc) coincides with
 * frequent self-corrections in assistant text.
 *
 * Heuristic: scan assistant text for short-fixed phrases that are
 * very rare in well-formed responses. False positives are acceptable
 * because the *count* matters, not any individual hit — we trip an
 * alert at >25 reversals per 1k tool calls.
 *
 * NOT used on the live HUD (too noisy at sub-second cadence). Daily
 * report only.
 */

const REVERSAL_PATTERNS = [
  /\bwait\b/gi,
  /\bactually\b/gi,
  /\blet me (?:fix|correct|redo|try again|re-?check)\b/gi,
  /\bhmm\b/gi,
  /\bon second thought\b/gi,
  /\bnever ?mind\b/gi,
  /\bsorry,? (?:that was|i was)\b/gi,
  /\bmy (?:mistake|apologies)\b/gi,
];

/**
 * @param {string} text - concatenated assistant message text
 * @returns {number} total reversal phrase matches
 */
export function countReasoningReversals(text) {
  if (!text || typeof text !== 'string') return 0;
  let total = 0;
  for (const re of REVERSAL_PATTERNS) {
    const m = text.match(re);
    if (m) total += m.length;
  }
  return total;
}

/**
 * Convenience: per-1k-tool-calls rate. Returns 0 when no tools recorded
 * (the rate would be undefined and a single reversal in a 5-tool session
 * shouldn't produce a 200/k panic number).
 *
 * @param {number} reversalCount
 * @param {number} toolCallCount
 * @returns {number}
 */
export function reversalsPer1k(reversalCount, toolCallCount) {
  if (!toolCallCount || toolCallCount < 10) return 0;
  return (reversalCount / toolCallCount) * 1000;
}
