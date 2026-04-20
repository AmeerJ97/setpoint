import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderUsageLine } from './usage.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function ctx({ fhCurrent = 50, fhTte = null, sdCurrent = 30, sdTte = null, narrow = false } = {}) {
  return {
    narrow,
    usageData: {
      fiveHour: fhCurrent,
      sevenDay: sdCurrent,
      fiveHourResetAt: new Date(Date.now() + 3600_000),
      sevenDayResetAt: new Date(Date.now() + 86400_000),
    },
    advisory: {
      fiveHour: { current: fhCurrent, projected: fhCurrent + 10, level: 'watch', tte: fhTte, peakActive: false, peakFraction: 0, peakMultiplier: 1 },
      sevenDay: { current: sdCurrent, projected: sdCurrent + 5,  level: 'ok',    tte: sdTte, peakActive: false, peakFraction: 0, peakMultiplier: 1 },
    },
  };
}

// TTE moved to Advisor line in Phase 6C — Usage line must no longer render it.
test('TTE is not rendered on the Usage line (moved to Advisor)', () => {
  const danger5h = strip(renderUsageLine(ctx({ fhTte: 25 * 60 })));
  const danger7d = strip(renderUsageLine(ctx({ sdTte: 6 * 3600 })));
  const safe = strip(renderUsageLine(ctx({ fhTte: 4 * 3600 })));
  for (const out of [danger5h, danger7d, safe]) {
    assert.doesNotMatch(out, /hits in/, 'Usage line should never render TTE');
    assert.doesNotMatch(out, /TTE/);
  }
});

test('limit-reached banner still replaces the Usage line', () => {
  const c = ctx({ fhTte: 25 * 60 });
  c.usageData.fiveHour = 100;
  const out = strip(renderUsageLine(c));
  assert.match(out, /Limit reached/);
});

test('peak-hour ⚡ glyph is shown when peak window is active', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = true;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 1;
  const out = strip(renderUsageLine(c));
  assert.match(out, /⚡/, 'expected lit ⚡ glyph during active peak window');
});

test('peak-hour ⚡ glyph is shown dim when peak hours are merely upcoming', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = false;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 0.4;
  const out = strip(renderUsageLine(c));
  assert.match(out, /⚡/, 'expected ⚡ glyph when peak hours upcoming inside the remaining window');
});

test('peak-hour ⚡ glyph is hidden when peak share is negligible', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = false;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 0.05;
  const out = strip(renderUsageLine(c));
  assert.doesNotMatch(out, /⚡/);
});
