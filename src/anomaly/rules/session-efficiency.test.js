import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSessionEfficiency, calculateEfficiency } from './session-efficiency.js';

describe('checkSessionEfficiency', () => {
  it('returns null for small sessions', () => {
    // MIN_INPUT_TO_CHECK = 10000
    assert.equal(checkSessionEfficiency({ inputTokens: 5000, outputTokens: 100 }), null);
  });

  it('returns null for efficient sessions', () => {
    const result = checkSessionEfficiency({
      inputTokens: 20000,
      outputTokens: 5000, // 25% efficiency
      cacheReadTokens: 0,
    });
    assert.equal(result, null);
  });

  it('triggers for inefficient sessions', () => {
    const result = checkSessionEfficiency({
      inputTokens: 80000,
      outputTokens: 2000, // 2.5% efficiency
      cacheReadTokens: 0,
    });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('efficiency'));
  });

  it('includes cache read tokens in calculation', () => {
    const result = checkSessionEfficiency({
      inputTokens: 35000,
      outputTokens: 1000,
      cacheReadTokens: 20000, // 55K total, ~1.8% efficiency
    });
    assert.equal(result.triggered, true);
  });

  it('returns null for invalid input', () => {
    assert.equal(checkSessionEfficiency(null), null);
    assert.equal(checkSessionEfficiency({}), null);
  });
});

describe('calculateEfficiency', () => {
  it('handles zero input', () => {
    const result = calculateEfficiency(0, 100, 0);
    assert.equal(result.efficiency, 0);
  });

  it('calculates efficiency correctly', () => {
    const result = calculateEfficiency(10000, 2000, 5000);
    // 2000 / (10000 + 5000) = 0.133
    assert.ok(Math.abs(result.efficiency - 0.133) < 0.01);
    assert.equal(result.level, 'medium');
  });

  it('classifies high efficiency', () => {
    const result = calculateEfficiency(10000, 3000, 0);
    // 30% efficiency
    assert.equal(result.level, 'high');
  });

  it('classifies low efficiency', () => {
    const result = calculateEfficiency(100000, 1000, 0);
    // 1% efficiency
    assert.equal(result.level, 'low');
  });
});
