import { TOKEN_SPIKE_THRESHOLD } from '../constants.js';

/**
 * Check for a single-turn token spike.
 * Only triggers on OUTPUT tokens per turn, NOT cumulative cache reads.
 *
 * @param {object} turnData
 * @param {number} [turnData.outputTokens] - output tokens for the CURRENT turn only
 * @returns {{ triggered: boolean, message: string }|null}
 */
export function checkTokenSpike(turnData) {
  if (!turnData) return null;

  // Only check output tokens per turn — NOT cumulative totals
  const outputThisTurn = turnData.outputTokens ?? 0;

  if (outputThisTurn > TOKEN_SPIKE_THRESHOLD) {
    return {
      triggered: true,
      message: `Token spike: ${outputThisTurn.toLocaleString()} output tokens in single turn (threshold: ${TOKEN_SPIKE_THRESHOLD.toLocaleString()})`,
      severity: 'warn',
    };
  }

  return null;
}
