import { MAX_SPAWNS_PER_HOUR } from '../constants.js';

/**
 * Detect runaway agent spawns.
 * @param {number} agentSpawns - count in current session
 * @param {number} sessionDurationMin - session duration in minutes
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */
export function checkRunawayAgent(agentSpawns, sessionDurationMin) {
  // Input validation
  const spawns = Number(agentSpawns);
  const duration = Number(sessionDurationMin);
  if (!Number.isFinite(spawns) || spawns < 0) return null;
  if (!Number.isFinite(duration) || duration < 0) return null;

  const hours = Math.max(0.1, duration / 60);
  const rate = spawns / hours;

  if (rate > MAX_SPAWNS_PER_HOUR) {
    return {
      triggered: true,
      message: `Runaway agent: ${spawns} spawns (${Math.round(rate)}/hr)`,
      severity: 'warn',
    };
  }
  return null;
}
