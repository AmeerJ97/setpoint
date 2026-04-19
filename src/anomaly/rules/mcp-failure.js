import { MCP_FAILURE_STREAK_THRESHOLD } from '../constants.js';

/**
 * Detect MCP failure streaks.
 * @param {Map<string, number>} failureCounts - MCP name -> consecutive failure count
 * @returns {Array<{ triggered: boolean, message: string, severity: string }>}
 */
export function checkMcpFailures(failureCounts) {
  // Input validation
  if (!failureCounts || typeof failureCounts[Symbol.iterator] !== 'function') {
    return [];
  }

  const alerts = [];
  for (const [name, count] of failureCounts) {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) continue;

    if (n >= MCP_FAILURE_STREAK_THRESHOLD) {
      alerts.push({
        triggered: true,
        message: `MCP failure streak: ${name} failed ${n}x consecutively`,
        severity: 'warn',
      });
    }
  }
  return alerts;
}
