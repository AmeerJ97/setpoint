import { MAX_COMPACTIONS_PER_SESSION } from '../constants.js';

/**
 * Detect excessive context compactions.
 * @param {number} compactionCount - times compaction fired this session
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */
export function checkContextThrash(compactionCount) {
  const count = Number(compactionCount);
  if (!Number.isFinite(count) || count < 0) return null;

  if (count > MAX_COMPACTIONS_PER_SESSION) {
    return {
      triggered: true,
      message: `thrash — ${count}× compacts`,
      severity: 'warn',
    };
  }
  return null;
}
