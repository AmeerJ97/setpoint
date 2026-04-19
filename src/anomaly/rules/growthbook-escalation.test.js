import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkGrowthBookEscalation } from './growthbook-escalation.js';

describe('checkGrowthBookEscalation', () => {
  it('returns null for zero activations', () => {
    assert.equal(checkGrowthBookEscalation(0), null);
  });

  it('returns null when below warn threshold', () => {
    assert.equal(checkGrowthBookEscalation(10), null);
    assert.equal(checkGrowthBookEscalation(240), null); // normal Anthropic sync rate
    assert.equal(checkGrowthBookEscalation(299), null);
  });

  it('triggers warn at 300/hr', () => {
    const result = checkGrowthBookEscalation(300);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('300'));
    assert.ok(result.message.includes('guard activations/hr'));
  });

  it('triggers warn between 300 and 500', () => {
    const result = checkGrowthBookEscalation(400);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
  });

  it('triggers critical at 500/hr', () => {
    const result = checkGrowthBookEscalation(500);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
    assert.ok(result.message.includes('critical'));
  });

  it('triggers critical above 500/hr', () => {
    const result = checkGrowthBookEscalation(800);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
  });

  it('rounds fractional rates', () => {
    const result = checkGrowthBookEscalation(350.7);
    assert.equal(result.triggered, true);
    assert.ok(result.message.includes('351'));
  });

  // Input validation tests
  it('returns null for NaN', () => {
    assert.equal(checkGrowthBookEscalation(NaN), null);
  });

  it('returns null for negative numbers', () => {
    assert.equal(checkGrowthBookEscalation(-5), null);
  });

  it('coerces string numbers', () => {
    const result = checkGrowthBookEscalation('400');
    assert.equal(result.triggered, true);
  });
});
