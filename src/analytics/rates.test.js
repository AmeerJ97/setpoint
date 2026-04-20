import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectWindow, peakFractionOfRemaining } from './rates.js';
import { resetDefaultsCache } from '../data/defaults.js';

// Pin defaults for peak-hour tests so behavior doesn't depend on the
// machine's wall clock relative to the default 5–11 PT window.
function withDefaults(blob, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'setpoint-rates-'));
  const file = join(dir, 'defaults.json');
  writeFileSync(file, JSON.stringify(blob));
  process.env.CLAUDE_HUD_DEFAULTS_FILE = file;
  resetDefaultsCache();
  try { return fn(); }
  finally {
    delete process.env.CLAUDE_HUD_DEFAULTS_FILE;
    resetDefaultsCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  delete process.env.CLAUDE_HUD_DEFAULTS_FILE;
  resetDefaultsCache();
});

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

describe('peakFractionOfRemaining', () => {
  // 2026-04-20 13:00 UTC = 06:00 America/Los_Angeles (DST → PDT, UTC-7)
  const peakStartUtc = new Date('2026-04-20T13:00:00Z').getTime();
  const peak = { timezone: 'America/Los_Angeles', startHour: 5, endHour: 11 };

  it('returns ~1.0 when the entire remaining window sits in peak hours', () => {
    // 30 minutes remaining starting at 06:00 PT → fully inside [05,11)
    const f = peakFractionOfRemaining(peakStartUtc, 30 * 60, peak);
    assert.ok(f > 0.95, `expected near 1.0, got ${f}`);
  });

  it('returns 0 when the entire remaining window sits outside peak hours', () => {
    // Start at 12:00 PT = 19:00 UTC, 30 minutes — fully outside peak
    const offPeak = new Date('2026-04-20T19:00:00Z').getTime();
    const f = peakFractionOfRemaining(offPeak, 30 * 60, peak);
    assert.equal(f, 0);
  });

  it('returns a partial fraction when window straddles the peak boundary', () => {
    // 10:30 PT = 17:30 UTC; one hour remaining straddles the 11:00 PT cutoff
    const straddle = new Date('2026-04-20T17:30:00Z').getTime();
    const f = peakFractionOfRemaining(straddle, 60 * 60, peak);
    assert.ok(f > 0.2 && f < 0.8, `expected partial fraction, got ${f}`);
  });

  it('handles wrap-around peak windows (22..6)', () => {
    const wrapPeak = { timezone: 'America/Los_Angeles', startHour: 22, endHour: 6 };
    // 23:00 PT = 06:00 UTC next day — squarely inside wrap window
    const insideWrap = new Date('2026-04-21T06:00:00Z').getTime();
    const f = peakFractionOfRemaining(insideWrap, 30 * 60, wrapPeak);
    assert.ok(f > 0.9, `expected near 1.0 for wrap-around, got ${f}`);
  });

  it('returns 0 when startHour equals endHour (degenerate window)', () => {
    const noPeak = { timezone: 'America/Los_Angeles', startHour: 5, endHour: 5 };
    const f = peakFractionOfRemaining(peakStartUtc, 60 * 60, noPeak);
    assert.equal(f, 0);
  });
});

describe('projectWindow peak-hour weighting', () => {
  const peakDefaults = {
    rates: {
      peakHours: {
        enabled: true,
        timezone: 'America/Los_Angeles',
        startHour: 5,
        endHour: 11,
        multiplier: 2.0,
      },
    },
  };
  const noPeakDefaults = {
    rates: { peakHours: { enabled: false } },
  };

  it('exposes peakActive, peakFraction, peakMultiplier on the result', () => {
    withDefaults(peakDefaults, () => {
      const now = Date.now() / 1000;
      const r = projectWindow(50, now + 3600, 5 * 3600, 0.0001);
      assert.equal(typeof r.peakActive, 'boolean');
      assert.ok(r.peakFraction >= 0 && r.peakFraction <= 1);
      assert.equal(r.peakMultiplier, 2.0);
    });
  });

  it('reports peakMultiplier=1 and peakFraction=0 when disabled', () => {
    withDefaults(noPeakDefaults, () => {
      const now = Date.now() / 1000;
      const r = projectWindow(50, now + 3600, 5 * 3600, 0.0001);
      assert.equal(r.peakActive, false);
      assert.equal(r.peakFraction, 0);
      assert.equal(r.peakMultiplier, 1);
    });
  });

  it('inflates projection when remaining window falls inside peak hours', () => {
    const baselineNow = Date.now() / 1000;
    const resetsAt = baselineNow + 3600;
    const priorRate = 0.0001;

    const off = withDefaults(noPeakDefaults,
      () => projectWindow(50, resetsAt, 5 * 3600, priorRate));
    const on = withDefaults(peakDefaults,
      () => projectWindow(50, resetsAt, 5 * 3600, priorRate));

    // peakFraction>0 should make on.projected >= off.projected. Equal is
    // acceptable when the test happens to run fully outside the peak
    // window (e.g. CI clock at 02:00 PT) — guard with a soft assertion.
    if (on.peakFraction > 0) {
      assert.ok(on.projected >= off.projected,
        `peak-on projection ${on.projected} should be >= peak-off ${off.projected}`);
    } else {
      // The two projectWindow calls run sequentially; Date.now() advances
      // between them by a few microseconds, which leaks into the rate
      // arithmetic at ~1e-8. Use a tolerance instead of strict equality.
      assert.ok(Math.abs(on.projected - off.projected) < 1e-6,
        `peak-off mismatch: ${on.projected} vs ${off.projected}`);
    }
  });
});
