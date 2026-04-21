/**
 * Context pressure anomaly rule.
 *
 * Proactively warns before context gets too full.
 * Based on Claude Code docs: "As context fills, Claude's performance degrades"
 *
 * @param {object} data
 * @param {number} [data.contextPercent] - current context window usage %
 * @param {number} [data.compactionCount] - number of compactions this session
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */

import { THRESHOLDS } from '../thresholds.js';

export function checkContextPressure(data) {
  const pct = Number(data?.contextPercent);
  if (!Number.isFinite(pct) || pct < 0) return null;

  const compactions = Number(data?.compactionCount ?? 0);

  // Critical: approaching auto-compact threshold
  if (pct >= THRESHOLDS.CONTEXT_CRITICAL_PCT) {
    return {
      triggered: true,
      message: `ctx ${Math.round(pct)}% — compact soon`,
      severity: 'critical',
      contextPercent: pct,
    };
  }

  // Warn: getting full, especially without compaction
  if (pct >= THRESHOLDS.CONTEXT_WARN_PCT && compactions === 0) {
    return {
      triggered: true,
      message: `ctx ${Math.round(pct)}% — pressure`,
      severity: 'warn',
      contextPercent: pct,
    };
  }

  return null;
}
