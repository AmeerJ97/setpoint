import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictProba, featuresFromMetrics, CLASSES, resetCache } from './classifier.js';

const MODEL = {
  weights: [
    [ 3.0, -0.5, -2.5],   // readEditRatio
    [-2.0,  0.0,  2.0],   // burnVelocity
    [-2.5,  0.0,  2.5],   // contextPct
    [-1.0,  0.0,  1.0],   // reversalsPer1k
    [ 0.5,  0.5, -1.0],   // bias
  ],
  scaler: { min: [0, 0, 0, 0], max: [20, 5, 100, 100] },
};

test('predictProba: healthy-looking session classifies healthy', () => {
  const r = predictProba(
    { readEditRatio: 8, burnVelocityVsP50: 0.8, contextPct: 20, reversalsPer1k: 5 },
    MODEL,
  );
  assert.equal(r.topClass, 'healthy');
  assert.ok(r.topProb > 0.5);
  assert.ok(r.probabilities.healthy > r.probabilities.risk);
});

test('predictProba: risk-looking session classifies risk', () => {
  const r = predictProba(
    { readEditRatio: 1, burnVelocityVsP50: 3.0, contextPct: 90, reversalsPer1k: 50 },
    MODEL,
  );
  assert.equal(r.topClass, 'risk');
  assert.ok(r.topProb > 0.5);
});

test('predictProba: probabilities sum to ~1', () => {
  const r = predictProba(
    { readEditRatio: 4, burnVelocityVsP50: 1.5, contextPct: 50, reversalsPer1k: 15 },
    MODEL,
  );
  const total = Object.values(r.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('predictProba: accepts raw array input in feature order', () => {
  const viaObj = predictProba(
    { readEditRatio: 5, burnVelocityVsP50: 2, contextPct: 40, reversalsPer1k: 10 },
    MODEL,
  );
  const viaArr = predictProba([5, 2, 40, 10], MODEL);
  assert.equal(viaObj.topClass, viaArr.topClass);
  assert.ok(Math.abs(viaObj.topProb - viaArr.topProb) < 1e-12);
});

test('predictProba: bad input returns null', () => {
  assert.equal(predictProba({ readEditRatio: NaN, burnVelocityVsP50: 1, contextPct: 50, reversalsPer1k: 0 }, MODEL), null);
  assert.equal(predictProba([1, 2, 3], MODEL), null);  // wrong length
});

test('loadWeights: default weights file loads and predicts', () => {
  resetCache();
  const r = predictProba(
    { readEditRatio: 1, burnVelocityVsP50: 3.0, contextPct: 90, reversalsPer1k: 50 },
  );
  assert.ok(r !== null);
  assert.ok(CLASSES.includes(r.topClass));
});

test('featuresFromMetrics: caps ratio at 20', () => {
  const f = featuresFromMetrics({ ratio: Infinity, burnVelocity: 1, contextPercent: 10 });
  assert.equal(f.readEditRatio, 20);
  assert.equal(f.reversalsPer1k, 0);  // default when missing
});

test('featuresFromMetrics: handles missing fields', () => {
  const f = featuresFromMetrics({});
  assert.equal(f.readEditRatio, 0);
  assert.equal(f.burnVelocityVsP50, 1.0);
  assert.equal(f.contextPct, 0);
  assert.equal(f.reversalsPer1k, 0);
});
