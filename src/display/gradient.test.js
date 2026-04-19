import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mix, rgbToOklab, oklabToRgb, hexToRgb,
  makeGradient, ansiTrueColor, ansi256FromRgb,
} from './gradient.js';

// Tight numerical tolerance for round-trips; Oklab conversion is
// lossy at the last bit due to gamma + cbrt.
const close = (a, b, eps = 2) => Math.abs(a - b) <= eps;

test('rgbToOklab → oklabToRgb round-trip preserves pure colors within 2/255', () => {
  for (const rgb of [[0,0,0],[255,255,255],[255,0,0],[0,255,0],[0,0,255],[128,128,128]]) {
    const back = oklabToRgb(rgbToOklab(rgb));
    assert.ok(close(back[0], rgb[0]), `r: ${back[0]} vs ${rgb[0]}`);
    assert.ok(close(back[1], rgb[1]), `g: ${back[1]} vs ${rgb[1]}`);
    assert.ok(close(back[2], rgb[2]), `b: ${back[2]} vs ${rgb[2]}`);
  }
});

test('hexToRgb parses 6-digit strings', () => {
  assert.deepEqual(hexToRgb('#ffffff'), [255, 255, 255]);
  assert.deepEqual(hexToRgb('#000000'), [0, 0, 0]);
  assert.deepEqual(hexToRgb('#0d1b3c'), [13, 27, 60]);
  assert.deepEqual(hexToRgb('ff0000'), [255, 0, 0]); // no leading # ok
});

test('mix at t=0 returns a, at t=1 returns b (within rounding)', () => {
  const a = [10, 20, 30];
  const b = [200, 100, 50];
  const zero = mix(a, b, 0);
  const one = mix(a, b, 1);
  assert.ok(close(zero[0], a[0]) && close(zero[1], a[1]) && close(zero[2], a[2]));
  assert.ok(close(one[0], b[0])  && close(one[1], b[1])  && close(one[2], b[2]));
});

test('mix at t=0.5 is perceptually between endpoints, not an RGB midpoint', () => {
  // Blue → yellow: sRGB midpoint is muddy gray (~127,127,127); Oklab
  // midpoint stays chromatic and warmer. Test the sanity property that
  // result is NOT just the component-wise average.
  const a = [0, 0, 255];    // blue
  const b = [255, 255, 0];  // yellow
  const mid = mix(a, b, 0.5);
  const rgbMid = [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
  ];
  // Not equal component-wise — Oklab mid is chromatic, sRGB mid is dull gray
  const distinct = Math.abs(mid[0] - rgbMid[0])
                 + Math.abs(mid[1] - rgbMid[1])
                 + Math.abs(mid[2] - rgbMid[2]);
  assert.ok(distinct > 20, `Oklab mid should differ from sRGB mid; got ${mid} vs ${rgbMid} (dist ${distinct})`);
});

test('makeGradient samples endpoints and interpolates between stops', () => {
  const g = makeGradient(['#000000', '#ff0000', '#ffffff']);
  const start = g(0);
  const end   = g(1);
  const low   = g(0.5);  // should be near pure red
  assert.ok(close(start[0], 0) && close(start[1], 0) && close(start[2], 0));
  assert.ok(close(end[0], 255) && close(end[1], 255) && close(end[2], 255));
  // At t=0.5, we're at the red stop exactly
  assert.ok(low[0] > 200 && low[1] < 60 && low[2] < 60,
    `red stop: ${low}`);
});

test('makeGradient clamps out-of-range t', () => {
  const g = makeGradient(['#000000', '#ffffff']);
  assert.deepEqual(g(-5), g(0));
  assert.deepEqual(g(5), g(1));
});

test('ansiTrueColor emits 24-bit SGR', () => {
  assert.equal(ansiTrueColor([10, 20, 30]), '\x1b[38;2;10;20;30m');
});

test('ansi256FromRgb quantizes to 256-color palette', () => {
  // Pure red in the 6x6x6 cube: 16 + 36*5 + 6*0 + 0 = 196
  assert.equal(ansi256FromRgb([255, 0, 0]), '\x1b[38;5;196m');
  // Pure white: 16 + 36*5 + 6*5 + 5 = 231
  assert.equal(ansi256FromRgb([255, 255, 255]), '\x1b[38;5;231m');
  // Near-gray should route to the grayscale ramp, not the cube
  const gray = ansi256FromRgb([128, 130, 129]);
  assert.match(gray, /\x1b\[38;5;(?:23[2-9]|24[0-9]|25[0-5])m/);
});
