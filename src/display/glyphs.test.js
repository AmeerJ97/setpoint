import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { g, resetGlyphCache, sanitizeForPlain } from './glyphs.js';

afterEach(() => {
  delete process.env.CLAUDE_OPS_PLAIN;
  delete process.env.CLAUDE_OPS_NERD;
  resetGlyphCache();
});

test('default returns BMP unicode glyphs', () => {
  assert.equal(g('check'), '✓');
  assert.equal(g('cross'), '✗');
  assert.equal(g('up_triangle'), '▲');
  assert.equal(g('block_full'), '█');
});

test('CLAUDE_OPS_PLAIN=1 returns ASCII fallbacks', () => {
  process.env.CLAUDE_OPS_PLAIN = '1';
  resetGlyphCache();
  assert.equal(g('check'), '+');
  assert.equal(g('cross'), 'x');
  assert.equal(g('up_triangle'), '^');
  assert.equal(g('arrow_right'), '->');
  assert.equal(g('block_full'), '#');
  assert.equal(g('gauge_open'), '|');
});

test('CLAUDE_OPS_NERD=1 returns Nerd Font glyphs', () => {
  process.env.CLAUDE_OPS_NERD = '1';
  resetGlyphCache();
  const check = g('check');
  assert.ok(check.charCodeAt(0) >= 0xe000, `nerd glyph should be in PUA; got U+${check.charCodeAt(0).toString(16)}`);
});

test('CLAUDE_OPS_PLAIN wins over CLAUDE_OPS_NERD', () => {
  process.env.CLAUDE_OPS_NERD = '1';
  process.env.CLAUDE_OPS_PLAIN = '1';
  resetGlyphCache();
  assert.equal(g('check'), '+');
});

test('unknown glyph name returns the name itself (fail-open)', () => {
  assert.equal(g('nonexistent_glyph_xyz'), 'nonexistent_glyph_xyz');
});

test('sanitizeForPlain strips ANSI escapes while downgrading glyphs', () => {
  process.env.CLAUDE_OPS_PLAIN = '1';
  resetGlyphCache();
  assert.equal(sanitizeForPlain('\x1b[31m✓ █\x1b[0m'), '+ #');
});
