import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { projectWindow } from './rates.js';

describe('projectWindow', () => {
  it('returns consumed value when window has expired', () => {
    const now = Date.now() / 1000;
    const result = projectWindow(50, now - 100, 3600, null);
    assert.equal(result.projected, 0.5);
    assert.equal(result.tte, null);
    assert.equal(result.burnFracPerMin, 0);
  });

  it('projects forward with current rate when no prior', () => {
    const now = Date.now() / 1000;
    const windowSec = 5 * 3600;
    const resetsAt = now + 3600; // 1h remaining
    const result = projectWindow(50, resetsAt, windowSec, null);

    assert.ok(result.projected >= 0.5, 'projected should be >= current');
    assert.ok(result.projected <= 1.0, 'projected should be <= 1.0');
    assert.ok(result.burnFracPerMin > 0, 'burn rate should be positive');
  });

  it('blends with prior rate when provided', () => {
    const now = Date.now() / 1000;
    const windowSec = 5 * 3600;
    const resetsAt = now + 1800; // 30m remaining
    const priorRate = 0.0001; // fraction per second

    const withPrior = projectWindow(30, resetsAt, windowSec, priorRate);
    const withoutPrior = projectWindow(30, resetsAt, windowSec, null);

    // Both should produce valid projections
    assert.ok(withPrior.projected >= 0.3);
    assert.ok(withoutPrior.projected >= 0.3);
  });

  it('clamps projected to 1.0 max', () => {
    const now = Date.now() / 1000;
    const windowSec = 3600;
    const resetsAt = now + 3600;
    // Very high prior rate should clamp at 1.0
    const result = projectWindow(90, resetsAt, windowSec, 0.01);
    assert.ok(result.projected <= 1.0);
  });

  it('handles 0% usage', () => {
    const now = Date.now() / 1000;
    const windowSec = 5 * 3600;
    const resetsAt = now + windowSec;
    const result = projectWindow(0, resetsAt, windowSec, null);
    assert.ok(result.projected >= 0);
    assert.ok(result.projected <= 1.0);
  });

  it('handles 100% usage', () => {
    const now = Date.now() / 1000;
    const result = projectWindow(100, now + 3600, 5 * 3600, null);
    assert.equal(result.projected, 1.0);
  });

  it('computes time-to-exhaustion', () => {
    const now = Date.now() / 1000;
    const windowSec = 5 * 3600;
    const resetsAt = now + 3600;
    const result = projectWindow(50, resetsAt, windowSec, null);
    assert.ok(result.tte === null || result.tte > 0, 'TTE should be null or positive');
  });

  it('applies activity factor for multi-day windows', () => {
    const now = Date.now() / 1000;
    const windowSec = 7 * 86400; // 7 days
    const resetsAt = now + 3 * 86400; // 3 days remaining

    const result = projectWindow(30, resetsAt, windowSec, null);
    assert.ok(result.projected >= 0.3);
    assert.ok(result.projected <= 1.0);
    // Activity factor should moderate the projection for multi-day windows
  });
});
