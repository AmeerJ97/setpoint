/**
 * Effort auto-swap decision function.
 *
 * Pure synchronous predicate over the current session's metrics plus
 * the last-swap bookkeeping. Returns `{target, reason}` where `target`
 * is the effort level the controller believes the session should run
 * at, or `null` when no change is warranted.
 *
 * The controller is intentionally conservative:
 *   - Only acts on Opus 4.7 sessions (`modelName` matches the regex).
 *   - Debounces swaps with a 10-minute minimum cooldown and a 5-point
 *     context-percent delta so a session sitting at the boundary
 *     doesn't oscillate.
 *   - Emits `null` on every indecisive render — the caller is
 *     responsible for writing the swap (this module has no I/O).
 *
 * Decision ladder (first match wins):
 *   1. ctx ≥ 70% OR burnVelocity ≥ 2.0×P90        → medium   (cheap)
 *   2. ctx ≥ 50% OR ratio < RE_RATIO_WARN          → high     (middle)
 *   3. ctx < 30% AND burnVelocity < 0.5×P50 AND
 *      ratio ≥ RE_RATIO_HEALTHY AND conf ≥ med     → xhigh    (deep)
 *   4. otherwise                                   → no change
 */

import { RE_RATIO_HEALTHY, RE_RATIO_WARN } from '../anomaly/constants.js';

const COOLDOWN_MS = 10 * 60 * 1000;          // 10 minutes between swaps
const CONTEXT_DELTA_THRESHOLD = 5;           // must shift by ≥ 5% since last swap
const OPUS_47_PATTERN = /claude-opus-4-7/i;  // only Opus 4.7 gets auto-swapped

/**
 * @typedef {object} EffortDecision
 * @property {'xhigh'|'high'|'medium'|null} target - target effort, null = no change
 * @property {string} reason - short human-readable explanation
 */

/**
 * @typedef {object} DecideInput
 * @property {number} contextPct - 0-100
 * @property {number} burnVelocity - burn-rate ÷ personal P50 baseline; 1.0 = typical
 * @property {number} ratio - read:edit ratio (Infinity when edits=0)
 * @property {'low'|'medium'|'high'|'xhigh'|'max'|'default'|string} current - current effort
 * @property {string} modelName - e.g. 'claude-opus-4-7'
 * @property {number} [burnP90=Infinity] - 90th-percentile burn baseline; guards step 1 when absent
 * @property {'low'|'med'|'high'} [confidence] - advisor confidence; step 3 requires ≥ med
 * @property {{ts: number, target: string, contextPct: number}|null} [lastSwap] - previous swap record
 * @property {number} [now=Date.now()] - injected for testability
 */

/**
 * @param {DecideInput} input
 * @returns {EffortDecision}
 */
export function decide(input) {
  const {
    contextPct,
    burnVelocity,
    ratio,
    current,
    modelName,
    burnP90 = Infinity,
    confidence = 'low',
    lastSwap = null,
    now = Date.now(),
  } = input;

  // Gate 0: respect user-set max. `max` is the user-locked deepest
  // tier; the auto-swap ladder never produces it and never downgrades
  // out of it. The user explicitly chose max for a reason.
  if (current === 'max') {
    return { target: null, reason: 'user-locked at max' };
  }

  // Gate 1: model family. Only Opus 4.7 sessions are candidates.
  if (!modelName || !OPUS_47_PATTERN.test(modelName)) {
    return { target: null, reason: 'not-opus-4-7' };
  }

  // Gate 2: inputs sane. Can't decide on partial/fresh sessions.
  if (!Number.isFinite(contextPct) || contextPct < 0) {
    return { target: null, reason: 'no-context-metric' };
  }

  // Gate 3: debounce by time + context-delta since last swap.
  if (lastSwap) {
    const sinceMs = now - lastSwap.ts;
    if (sinceMs < COOLDOWN_MS) {
      return { target: null, reason: `cooldown ${Math.round((COOLDOWN_MS - sinceMs) / 60_000)}m` };
    }
    if (Math.abs(contextPct - lastSwap.contextPct) < CONTEXT_DELTA_THRESHOLD) {
      return { target: null, reason: 'context delta too small' };
    }
  }

  // Decision ladder.
  let target;
  let reason;

  if (contextPct >= 70 || (Number.isFinite(burnVelocity) && burnVelocity >= 2.0)) {
    target = 'medium';
    reason = contextPct >= 70 ? `ctx ${Math.round(contextPct)}%` : `burn ${burnVelocity.toFixed(1)}×`;
  } else if (contextPct >= 50 || (Number.isFinite(ratio) && ratio < RE_RATIO_WARN)) {
    target = 'high';
    reason = contextPct >= 50 ? `ctx ${Math.round(contextPct)}%` : `R:E ${ratio.toFixed(1)}`;
  } else if (
    contextPct < 30 &&
    Number.isFinite(burnVelocity) && burnVelocity < 0.5 &&
    Number.isFinite(ratio) && ratio >= RE_RATIO_HEALTHY &&
    (confidence === 'med' || confidence === 'high')
  ) {
    target = 'xhigh';
    reason = `ctx ${Math.round(contextPct)}%, burn ${burnVelocity.toFixed(1)}×, R:E ${ratio.toFixed(1)}`;
  } else {
    return { target: null, reason: 'in-band' };
  }

  // Gate 4: if target matches current, no swap needed.
  if (target === current) {
    return { target: null, reason: `already ${target}` };
  }

  return { target, reason };
}
