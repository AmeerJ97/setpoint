import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getQuotaColor,
  getContextColor,
  getBurnColor,
  getCacheColor,
  getEffortColor,
  setColorMode,
} from './colors.js';

// Pin the threshold-color tests to ansi16 mode so we can assert the
// legacy 3-band SGR codes. Truecolor/ansi256 tests live separately.
before(() => setColorMode('ansi16', 'cividis'));
after(()  => setColorMode(null));

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

test('getQuotaColor matches HUD-SPEC: green < 50, yellow 50-80, red >= 80', () => {
  assert.equal(getQuotaColor(0), GREEN);
  assert.equal(getQuotaColor(49.9), GREEN);
  assert.equal(getQuotaColor(50), YELLOW);
  assert.equal(getQuotaColor(79.9), YELLOW);
  assert.equal(getQuotaColor(80), RED);
  assert.equal(getQuotaColor(100), RED);
});

test('getContextColor: green < 70, yellow 70-85, red >= 85', () => {
  assert.equal(getContextColor(0), GREEN);
  assert.equal(getContextColor(69.9), GREEN);
  assert.equal(getContextColor(70), YELLOW);
  assert.equal(getContextColor(84.9), YELLOW);
  assert.equal(getContextColor(85), RED);
});

test('getBurnColor: green < 200, yellow 200-999, red >= 1000', () => {
  // Thresholds are now inclusive on the upper band edge (>= triggers
  // the next band) — matches getQuotaColor / getContextColor semantics.
  assert.equal(getBurnColor(0), GREEN);
  assert.equal(getBurnColor(199), GREEN);
  assert.equal(getBurnColor(200), YELLOW);
  assert.equal(getBurnColor(999), YELLOW);
  assert.equal(getBurnColor(1000), RED);
});

test('getCacheColor: inverse of quota — green high, red low', () => {
  assert.equal(getCacheColor(90), GREEN);
  assert.equal(getCacheColor(60), YELLOW);
  assert.equal(getCacheColor(30), RED);
});

test('getEffortColor', () => {
  assert.equal(getEffortColor('high'), GREEN);
  assert.equal(getEffortColor('max'), GREEN);
  assert.equal(getEffortColor('medium'), YELLOW);
  assert.equal(getEffortColor('low'), RED);
  assert.equal(getEffortColor('default'), RED);
});
