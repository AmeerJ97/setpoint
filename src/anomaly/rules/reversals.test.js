import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReversals, REVERSALS_THRESHOLDS } from './reversals.js';

test('fires warn when rate exceeds 25/1k on a substantive session', () => {
  const r = checkReversals({ reversalsPer1k: 40, toolCallCount: 200 });
  assert.ok(r);
  assert.equal(r.triggered, true);
  assert.equal(r.severity, 'warn');
  assert.match(r.message, /40\.0\/1k/);
});

test('silent below the warn threshold', () => {
  const r = checkReversals({ reversalsPer1k: 10, toolCallCount: 200 });
  assert.equal(r, null);
});

test('silent on tiny samples regardless of rate (no MIN_CALLS signal)', () => {
  const r = checkReversals({
    reversalsPer1k: 200,
    toolCallCount: REVERSALS_THRESHOLDS.MIN_CALLS_FOR_SIGNAL - 1,
  });
  assert.equal(r, null);
});

test('silent on missing or non-finite rate', () => {
  assert.equal(checkReversals({ toolCallCount: 100 }), null);
  assert.equal(checkReversals({ reversalsPer1k: NaN, toolCallCount: 100 }), null);
});

test('boundary: rate === WARN_PER_1K fires', () => {
  const r = checkReversals({
    reversalsPer1k: REVERSALS_THRESHOLDS.WARN_PER_1K,
    toolCallCount: 100,
  });
  assert.ok(r?.triggered);
});
