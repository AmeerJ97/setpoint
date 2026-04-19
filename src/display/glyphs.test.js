import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { g, resetGlyphCache } from './glyphs.js';

afterEach(() => {
  delete process.env.SETPOINT_PLAIN;
  delete process.env.SETPOINT_NERD;
  resetGlyphCache();
});

test('default returns BMP unicode glyphs', () => {
  assert.equal(g('check'), '✓');
  assert.equal(g('cross'), '✗');
  assert.equal(g('up_triangle'), '▲');
  assert.equal(g('block_full'), '█');
});

test('SETPOINT_PLAIN=1 returns ASCII fallbacks', () => {
  process.env.SETPOINT_PLAIN = '1';
  resetGlyphCache();
  assert.equal(g('check'), '+');
  assert.equal(g('cross'), 'x');
  assert.equal(g('up_triangle'), '^');
  assert.equal(g('arrow_right'), '->');
  assert.equal(g('block_full'), '#');
  assert.equal(g('gauge_open'), '|');
});

test('SETPOINT_NERD=1 returns Nerd Font glyphs', () => {
  process.env.SETPOINT_NERD = '1';
  resetGlyphCache();
  const check = g('check');
  assert.ok(check.charCodeAt(0) >= 0xe000, `nerd glyph should be in PUA; got U+${check.charCodeAt(0).toString(16)}`);
});

test('SETPOINT_PLAIN wins over SETPOINT_NERD', () => {
  process.env.SETPOINT_NERD = '1';
  process.env.SETPOINT_PLAIN = '1';
  resetGlyphCache();
  assert.equal(g('check'), '+');
});

test('unknown glyph name returns the name itself (fail-open)', () => {
  assert.equal(g('nonexistent_glyph_xyz'), 'nonexistent_glyph_xyz');
});
