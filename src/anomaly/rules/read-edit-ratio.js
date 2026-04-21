/**
 * Read:Edit ratio anomaly rule.
 *
 * Monitors the ratio of research tools (Read, Grep, Glob, WebSearch, WebFetch)
 * to mutation tools (Edit, Write) per session. A healthy session has ratio >= 3.0
 * (reading 3x more than editing). When the ratio drops below 2.0, the model is
 * likely pattern-matching / editing without understanding context.
 *
 * Based on findings from anthropics/claude-code#42796:
 *   - Good period: 6.6 reads per edit
 *   - Degraded period: 2.0 reads per edit
 *
 * The critical threshold (hard limit) only fires for Opus 4.6, since smaller
 * models naturally have lower read:edit ratios due to agent delegation patterns.
 *
 * @param {object} data
 * @param {Record<string, number>} [data.toolCounts] - tool name -> invocation count
 * @param {string} [data.modelName] - active model display name or ID
 * @returns {{ triggered: boolean, message: string, severity: string, ratio: number }|null}
 */

import {
  RE_RATIO_WARN,
  RE_RATIO_CRITICAL,
  RE_MIN_EDITS,
  countReadEdits,
  calculateRatio,
  isOpus,
} from '../constants.js';

export function checkReadEditRatio(data) {
  const toolCounts = data?.toolCounts;
  if (!toolCounts || typeof toolCounts !== 'object') return null;

  const { reads, edits } = countReadEdits(toolCounts);

  if (edits < RE_MIN_EDITS) return null;

  const ratio = calculateRatio(reads, edits);

  // Critical threshold only applies to Opus 4.6
  if (ratio < RE_RATIO_CRITICAL && isOpus(data.modelName)) {
    return {
      triggered: true,
      message: `R:E ${ratio.toFixed(1)} (${reads}r/${edits}e) — edit-first`,
      severity: 'critical',
      ratio,
      reads,
      edits,
    };
  }

  if (ratio < RE_RATIO_WARN) {
    return {
      triggered: true,
      message: `R:E ${ratio.toFixed(1)} (${reads}r/${edits}e) — shallow`,
      severity: 'warn',
      ratio,
      reads,
      edits,
    };
  }

  return { triggered: false, message: '', severity: 'ok', ratio, reads, edits };
}
