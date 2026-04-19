import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeEfficiency } from './efficiency.js';

test('returns zeros for empty sessions', () => {
  const r = analyzeEfficiency([]);
  assert.equal(r.score, 0);
  assert.equal(r.productiveRatio, 0);
});

test('score and productiveRatio are identical when cacheCreate is zero', () => {
  const r = analyzeEfficiency([{ totalInput: 1000, totalOutput: 500, totalCacheCreate: 0 }]);
  assert.equal(r.score, r.productiveRatio);
  assert.equal(r.score, Math.round((500 / 1500) * 100));
});

test('score and productiveRatio diverge when cacheCreate is present', () => {
  const r = analyzeEfficiency([{ totalInput: 100, totalOutput: 100, totalCacheCreate: 10000 }]);
  // score: 100 / (100+100) = 50
  assert.equal(r.score, 50);
  // productiveRatio: 100 / (100+100+10000) ≈ 1
  assert.equal(r.productiveRatio, 1);
  assert.notEqual(r.score, r.productiveRatio);
});

test('cacheRead is ignored (does not affect either denominator)', () => {
  const a = analyzeEfficiency([{ totalInput: 100, totalOutput: 100, totalCacheCreate: 0 }]);
  const b = analyzeEfficiency([{ totalInput: 100, totalOutput: 100, totalCacheCreate: 0, totalCacheRead: 50000 }]);
  assert.deepEqual(a, b);
});

test('summary mentions both score and productiveRatio', () => {
  const r = analyzeEfficiency([{ totalInput: 100, totalOutput: 100, totalCacheCreate: 200 }]);
  assert.match(r.summary, /output-share/);
  assert.match(r.summary, /of total invest/);
});
