import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkContextThrash } from './context-thrash.js';

describe('checkContextThrash', () => {
  it('returns null when compaction count is zero', () => {
    assert.equal(checkContextThrash(0), null);
  });

  it('returns null when at or below threshold', () => {
    assert.equal(checkContextThrash(1), null);
    assert.equal(checkContextThrash(5), null); // MAX_COMPACTIONS = 5
  });

  it('triggers when compaction count exceeds threshold', () => {
    const result = checkContextThrash(6);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('6 compactions'));
  });

  it('handles large compaction counts', () => {
    const result = checkContextThrash(20);
    assert.equal(result.triggered, true);
    assert.ok(result.message.includes('20 compactions'));
  });

  // Input validation tests
  it('returns null for NaN', () => {
    assert.equal(checkContextThrash(NaN), null);
  });

  it('returns null for negative numbers', () => {
    assert.equal(checkContextThrash(-1), null);
  });

  it('coerces string numbers', () => {
    const result = checkContextThrash('10');
    assert.equal(result.triggered, true);
  });
});
