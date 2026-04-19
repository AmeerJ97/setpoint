import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkRunawayAgent } from './runaway-agent.js';

describe('checkRunawayAgent', () => {
  it('returns null when spawn rate is under threshold', () => {
    // 50 spawns / 2 hours = 25/hr (threshold is 50/hr)
    assert.equal(checkRunawayAgent(50, 120), null);
  });

  it('returns null for zero spawns', () => {
    assert.equal(checkRunawayAgent(0, 60), null);
  });

  it('triggers when spawn rate exceeds threshold', () => {
    // 60 spawns / 1 hour = 60/hr (exceeds 50/hr)
    const result = checkRunawayAgent(60, 60);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('60 spawns'));
    assert.ok(result.message.includes('60/hr'));
  });

  it('handles very short sessions (minimum 0.1 hours)', () => {
    // 10 spawns / 1 minute = 10 / 0.1 hr = 100/hr
    const result = checkRunawayAgent(10, 1);
    assert.equal(result.triggered, true);
  });

  it('handles edge case at exactly threshold', () => {
    // 50 spawns / 1 hour = exactly 50/hr (not > 50)
    const result = checkRunawayAgent(50, 60);
    assert.equal(result, null);
  });

  it('triggers just above threshold', () => {
    // 51 spawns / 1 hour = 51/hr
    const result = checkRunawayAgent(51, 60);
    assert.equal(result.triggered, true);
  });

  // Input validation tests
  it('returns null for NaN inputs', () => {
    assert.equal(checkRunawayAgent(NaN, 60), null);
    assert.equal(checkRunawayAgent(10, NaN), null);
  });

  it('returns null for negative inputs', () => {
    assert.equal(checkRunawayAgent(-5, 60), null);
    assert.equal(checkRunawayAgent(10, -30), null);
  });

  it('coerces string numbers', () => {
    const result = checkRunawayAgent('60', '60');
    assert.equal(result.triggered, true);
  });
});
