import { GUARD_ACTIVATIONS_WARN, GUARD_ACTIVATIONS_CRITICAL } from '../constants.js';

/**
 * Detect GrowthBook config escalation (rapid guard activations).
 * Two-tier: warn at 300/hr, critical at 500/hr.
 * @param {number} activationsPerHour - guard activation rate
 * @returns {{ triggered: boolean, message: string, severity: string }|null}
 */
export function checkGrowthBookEscalation(activationsPerHour) {
  const rate = Number(activationsPerHour);
  if (!Number.isFinite(rate) || rate < 0) return null;

  if (rate >= GUARD_ACTIVATIONS_CRITICAL) {
    return {
      triggered: true,
      message: `GrowthBook escalation: ${Math.round(rate)} guard activations/hr (critical)`,
      severity: 'critical',
    };
  }
  if (rate >= GUARD_ACTIVATIONS_WARN) {
    return {
      triggered: true,
      message: `GrowthBook escalation: ${Math.round(rate)} guard activations/hr`,
      severity: 'warn',
    };
  }
  return null;
}
