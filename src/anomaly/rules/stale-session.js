import { MAX_HOURS_WITHOUT_COMPACTION } from '../constants.js';

/**
 * Detect stale sessions without compaction.
 * @param {number} sessionDurationMin - session duration in minutes
 * @param {number} compactionCount - number of compactions
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */
export function checkStaleSession(sessionDurationMin, compactionCount) {
  const duration = Number(sessionDurationMin);
  const compactions = Number(compactionCount);
  if (!Number.isFinite(duration) || duration < 0) return null;
  if (!Number.isFinite(compactions) || compactions < 0) return null;

  const hours = duration / 60;
  if (hours > MAX_HOURS_WITHOUT_COMPACTION && compactions === 0) {
    return {
      triggered: true,
      message: `stale ${hours.toFixed(1)}h — no compact`,
      severity: 'warn',
    };
  }
  return null;
}
