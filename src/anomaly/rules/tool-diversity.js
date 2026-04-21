/**
 * Tool diversity anomaly rule.
 *
 * Detects when model is using too few tool types, which may indicate
 * shallow reasoning or over-reliance on a single approach.
 *
 * Good sessions use: Read, Grep, Glob, Edit, Write, Bash, etc.
 * Shallow sessions may only use: Edit, Edit, Edit...
 *
 * @param {object} data
 * @param {Record<string, number>} [data.toolCounts] - tool name -> count
 * @param {number} [data.totalToolCalls] - total tool invocations
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */

import { THRESHOLDS } from '../thresholds.js';

const MIN_CALLS_TO_CHECK = 10; // Don't alert on early sessions

export function checkToolDiversity(data) {
  const toolCounts = data?.toolCounts;
  if (!toolCounts || typeof toolCounts !== 'object') return null;

  const entries = Object.entries(toolCounts);
  const totalCalls = entries.reduce((sum, [, count]) => sum + count, 0);

  if (totalCalls < MIN_CALLS_TO_CHECK) return null;

  const uniqueTools = entries.filter(([, count]) => count > 0).length;
  const diversityScore = uniqueTools / Math.max(1, Math.sqrt(totalCalls));

  // Check if using too few unique tools
  if (uniqueTools < THRESHOLDS.MIN_TOOL_DIVERSITY) {
    const toolList = entries
      .filter(([, c]) => c > 0)
      .map(([name, c]) => `${name}:${c}`)
      .join(', ');

    return {
      triggered: true,
      message: `${uniqueTools} tool types only`,
      severity: 'warn',
      uniqueTools,
      totalCalls,
      diversityScore,
    };
  }

  return null;
}

/**
 * Calculate tool diversity score for display.
 * @param {Record<string, number>} toolCounts
 * @returns {{ unique: number, total: number, score: number }}
 */
export function calculateDiversity(toolCounts) {
  if (!toolCounts || typeof toolCounts !== 'object') {
    return { unique: 0, total: 0, score: 0 };
  }

  const entries = Object.entries(toolCounts);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const unique = entries.filter(([, count]) => count > 0).length;
  const score = unique / Math.max(1, Math.sqrt(total));

  return { unique, total, score };
}
