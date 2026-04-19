/**
 * Session efficiency anomaly rule.
 *
 * Tracks the ratio of productive output to total tokens consumed.
 * Low efficiency may indicate:
 * - Excessive context reading without action
 * - Repeated failures and retries
 * - Meandering exploration without progress
 *
 * @param {object} data
 * @param {number} [data.inputTokens] - total input tokens
 * @param {number} [data.outputTokens] - total output tokens
 * @param {number} [data.cacheReadTokens] - cache read tokens
 * @param {number} [data.toolSuccessCount] - successful tool calls
 * @param {number} [data.toolErrorCount] - failed tool calls
 * @returns {{ triggered: boolean, message: string, severity: string, efficiency: number }|null}
 */

import { THRESHOLDS } from '../thresholds.js';

const MIN_INPUT_TO_CHECK = 10000; // Don't alert on tiny sessions

export function checkSessionEfficiency(data) {
  const input = Number(data?.inputTokens ?? 0);
  const output = Number(data?.outputTokens ?? 0);
  const cacheRead = Number(data?.cacheReadTokens ?? 0);

  if (!Number.isFinite(input) || input < MIN_INPUT_TO_CHECK) return null;

  // Efficiency = output / (input + cacheRead)
  // Higher is better: model is producing more relative to what it consumes
  const totalConsumed = input + cacheRead;
  const efficiency = totalConsumed > 0 ? output / totalConsumed : 0;

  // Tool success rate if available
  const successCount = Number(data?.toolSuccessCount ?? 0);
  const errorCount = Number(data?.toolErrorCount ?? 0);
  const totalTools = successCount + errorCount;
  const successRate = totalTools > 0 ? successCount / totalTools : 1;

  // Combined score
  const score = efficiency * successRate;

  if (efficiency < THRESHOLDS.MIN_EFFICIENCY_RATIO && totalConsumed > 50000) {
    return {
      triggered: true,
      message: `Low efficiency: ${(efficiency * 100).toFixed(1)}% output/input ratio — may indicate wasteful exploration`,
      severity: 'warn',
      efficiency,
      inputTokens: input,
      outputTokens: output,
      successRate,
    };
  }

  return null;
}

/**
 * Calculate efficiency metrics for display.
 * @param {number} input
 * @param {number} output
 * @param {number} [cacheRead=0]
 * @returns {{ efficiency: number, level: 'high'|'medium'|'low' }}
 */
export function calculateEfficiency(input, output, cacheRead = 0) {
  const totalConsumed = (input || 0) + (cacheRead || 0);
  const efficiency = totalConsumed > 0 ? (output || 0) / totalConsumed : 0;

  let level = 'high';
  if (efficiency < 0.05) level = 'low';
  else if (efficiency < 0.15) level = 'medium';

  return { efficiency, level };
}
