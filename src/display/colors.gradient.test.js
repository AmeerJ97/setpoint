/*
 * Truecolor-mode behaviour for threshold colors. Threshold functions
 * snap to the band's state color (ok/warn/critical) for crisp discrete
 * transitions — no mid-band interpolation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setColorMode,
  getQuotaColor,
  getContextColor,
  getBurnColor,
  getCacheColor,
  getEffortColor,
  green, yellow, red, dim,
  coloredBar, octantBar,
} from './colors.js';

before(() => setColorMode('truecolor', 'rag'));
after(()  => setColorMode(null));

const parseSgr = (esc) => {
  const m = esc.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
  return m ? [+m[1], +m[2], +m[3]] : null;
};

test('truecolor mode emits 24-bit SGR for threshold colors', () => {
  const esc = getQuotaColor(50);
  assert.match(esc, /\x1b\[38;2;\d+;\d+;\d+m/);
});

test('values inside the same band produce identical colors (no mid-band muddiness)', () => {
  // 10% and 40% both live in the "ok" band (0..49) for quota, so they
  // should snap to the same vivid green — not an interpolated olive.
  const a = parseSgr(getQuotaColor(10));
  const b = parseSgr(getQuotaColor(40));
  assert.deepEqual(a, b, `same band, same color; got ${a} vs ${b}`);
});

test('crossing a threshold shifts to a distinct color', () => {
  // Quota bands: ok <50, warn 50-79, critical >=80. The shift at 50
  // should be unmistakable (green → yellow).
  const below = parseSgr(getQuotaColor(49));
  const above = parseSgr(getQuotaColor(50));
  assert.notDeepEqual(below, above, 'threshold at 50 must shift color');
  const dist = Math.abs(below[0] - above[0]) + Math.abs(below[1] - above[1]) + Math.abs(below[2] - above[2]);
  assert.ok(dist > 100, `threshold shift should be vivid; got ${below} vs ${above}`);
});

test('clamped endpoints: 0% is the ok state, 100% is the critical state', () => {
  const lo = parseSgr(getQuotaColor(0));
  const hi = parseSgr(getQuotaColor(100));
  // RAG: ok=green #22c55e → critical=red #ef4444
  assert.ok(lo[1] > lo[0] && lo[1] > lo[2], `0% should be green-dominant; got ${lo}`);
  assert.ok(hi[0] > hi[1] && hi[0] > hi[2], `100% should be red-dominant; got ${hi}`);
});

test('getEffortColor returns palette colors, not raw SGR codes', () => {
  assert.match(getEffortColor('high'), /\x1b\[38;2;\d+;\d+;\d+m/);
  assert.match(getEffortColor('medium'), /\x1b\[38;2;\d+;\d+;\d+m/);
  assert.match(getEffortColor('low'), /\x1b\[38;2;\d+;\d+;\d+m/);
});

test('NO_COLOR-equivalent mode returns empty string', () => {
  setColorMode('none');
  try {
    assert.equal(getQuotaColor(50), '');
    assert.equal(green('x'), 'x', 'plain color fns strip escapes too');
    assert.equal(dim('x'), 'x');
  } finally {
    setColorMode('truecolor', 'cividis');
  }
});

test('coloredBar still produces a bar of the right width', () => {
  const bar = coloredBar(50, 10);
  // Strip ANSI to count glyphs
  const glyphs = bar.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal([...glyphs].length, 10, 'bar has 10 visible cells');
});

test('octantBar gives sub-character precision for 0..100', () => {
  const b0 = octantBar(0, 10).replace(/\x1b\[[0-9;]*m/g, '');
  const b50 = octantBar(50, 10).replace(/\x1b\[[0-9;]*m/g, '');
  const b100 = octantBar(100, 10).replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal([...b0].length, 10);
  assert.equal([...b100].length, 10);
  // 50% of 10 cells = 5 full blocks + 5 empties
  assert.match(b50, /█{5}░{5}/);
  // Between cells — 25% = 2 full + one partial
  const b25 = octantBar(25, 10).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(b25, /█{2}[▏▎▍▌▋▊▉]/, `expected partial-cell marker; got "${b25}"`);
});

test('rag palette can be selected and produces different colors', () => {
  setColorMode('truecolor', 'rag');
  try {
    const ragGreen = parseSgr(getQuotaColor(10));
    setColorMode('truecolor', 'cividis');
    const cividisLow = parseSgr(getQuotaColor(10));
    const dist = Math.abs(ragGreen[0] - cividisLow[0])
               + Math.abs(ragGreen[1] - cividisLow[1])
               + Math.abs(ragGreen[2] - cividisLow[2]);
    assert.ok(dist > 30, `palettes should differ; rag ${ragGreen} vs cividis ${cividisLow}`);
  } finally {
    setColorMode('truecolor', 'cividis');
  }
});
