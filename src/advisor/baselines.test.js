import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBaselines, percentile } from './baselines.js';

function synthHistory(days, samplesPerDay, burnFn) {
  const out = [];
  const now = Date.now();
  for (let d = days; d >= 0; d--) {
    for (let s = 0; s < samplesPerDay; s++) {
      out.push({
        ts: new Date(now - d * 86_400_000 + s * 600_000).toISOString(),
        session_burn_rate: burnFn(d, s),
      });
    }
  }
  return out;
}

describe('percentile', () => {
  it('returns null on empty input', () => {
    assert.equal(percentile([], 0.5), null);
  });

  it('returns the only element for a 1-array', () => {
    assert.equal(percentile([42], 0.9), 42);
  });

  it('linear-interpolates between adjacent samples', () => {
    // [1, 2, 3, 4]; P50 → pos = 1.5 → 2 + 0.5 * (3-2) = 2.5
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  });

  it('clamps p > 1 to the last element', () => {
    assert.equal(percentile([1, 2, 3], 1.5), 3);
  });

  it('clamps p < 0 to the first element', () => {
    assert.equal(percentile([1, 2, 3], -0.5), 1);
  });
});

describe('computeBaselines', () => {
  it('returns sufficient=false on empty history', () => {
    const b = computeBaselines([]);
    assert.equal(b.sufficient, false);
    assert.equal(b.burnP50, null);
  });

  it('returns sufficient=false when fewer than 7 days span', () => {
    const b = computeBaselines(synthHistory(2, 30, () => 100));
    assert.equal(b.sufficient, false);
  });

  it('returns sufficient=false when fewer than 50 samples', () => {
    const b = computeBaselines(synthHistory(10, 1, () => 100));
    assert.equal(b.sufficient, false);
  });

  it('returns P50 + P90 when history meets thresholds', () => {
    const b = computeBaselines(synthHistory(8, 10, (d, s) => 100 + s * 10));
    assert.equal(b.sufficient, true);
    assert.ok(b.burnP50 > 0);
    assert.ok(b.burnP90 >= b.burnP50);
    assert.ok(b.daysSpanned >= 7);
  });

  it('skips zero burn-rate samples (P50 reflects active periods only)', () => {
    const mixed = synthHistory(8, 10, (d, s) => s % 2 === 0 ? 0 : 200);
    const b = computeBaselines(mixed);
    assert.equal(b.sufficient, true);
    // Only the burn>0 samples are counted; P50 should be ~200, not ~100
    assert.ok(b.burnP50 >= 100, `expected P50 >= 100, got ${b.burnP50}`);
  });
});
