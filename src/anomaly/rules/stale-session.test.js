import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkStaleSession } from './stale-session.js';

describe('checkStaleSession', () => {
  it('returns null for short sessions', () => {
    // 2 hours without compaction is fine
    assert.equal(checkStaleSession(120, 0), null);
  });

  it('returns null at exactly threshold', () => {
    // 4 hours exactly (MAX_HOURS_WITHOUT_COMPACTION = 4)
    assert.equal(checkStaleSession(240, 0), null);
  });

  it('triggers when session exceeds threshold without compaction', () => {
    // 5 hours without compaction
    const result = checkStaleSession(300, 0);
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('5.0h'));
    assert.ok(result.message.includes('no compact'));
  });

  it('returns null for long sessions with compaction', () => {
    // 10 hours but has 1+ compactions
    assert.equal(checkStaleSession(600, 1), null);
    assert.equal(checkStaleSession(600, 5), null);
  });

  it('handles fractional hours', () => {
    const result = checkStaleSession(270, 0); // 4.5 hours
    assert.equal(result.triggered, true);
    assert.ok(result.message.includes('4.5h'));
  });

  // Input validation tests
  it('returns null for NaN inputs', () => {
    assert.equal(checkStaleSession(NaN, 0), null);
    assert.equal(checkStaleSession(300, NaN), null);
  });

  it('returns null for negative inputs', () => {
    assert.equal(checkStaleSession(-60, 0), null);
    assert.equal(checkStaleSession(300, -1), null);
  });

  it('coerces string numbers', () => {
    const result = checkStaleSession('300', '0');
    assert.equal(result.triggered, true);
  });
});
