import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectColorSupport, detectPalette, useNerdGlyphs, usePlainGlyphs } from './capability.js';

function ctx(env, isTTY = true) { return { env, isTTY }; }

test('NO_COLOR disables color even on truecolor TTY', () => {
  assert.equal(detectColorSupport(ctx({ NO_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' })), 'none');
});

test('SETPOINT_PLAIN disables color', () => {
  assert.equal(detectColorSupport(ctx({ SETPOINT_PLAIN: '1', COLORTERM: 'truecolor' })), 'none');
});

test('Claude Code statusLine case: non-TTY with inherited COLORTERM still emits color', () => {
  // The parent shell sets COLORTERM=truecolor and TERM=tmux-256color;
  // Claude Code spawns setpoint with stdout piped, so isTTY=false.
  // The user's terminal still renders the ANSI output.
  assert.equal(
    detectColorSupport(ctx({ COLORTERM: 'truecolor', TERM: 'tmux-256color' }, false)),
    'truecolor',
  );
});

test('FORCE_COLOR=3 forces truecolor regardless of TTY', () => {
  assert.equal(detectColorSupport(ctx({ FORCE_COLOR: '3' }, false)), 'truecolor');
});

test('FORCE_COLOR=2 forces ansi256', () => {
  assert.equal(detectColorSupport(ctx({ FORCE_COLOR: '2' })), 'ansi256');
});

test('FORCE_COLOR=1 forces ansi16', () => {
  assert.equal(detectColorSupport(ctx({ FORCE_COLOR: '1' })), 'ansi16');
});

test('FORCE_COLOR=0 disables color (overrides COLORTERM)', () => {
  assert.equal(detectColorSupport(ctx({ FORCE_COLOR: '0', COLORTERM: 'truecolor' })), 'none');
});

test('COLORTERM=truecolor yields truecolor', () => {
  assert.equal(detectColorSupport(ctx({ COLORTERM: 'truecolor', TERM: 'xterm-256color' })), 'truecolor');
});

test('COLORTERM=24bit yields truecolor', () => {
  assert.equal(detectColorSupport(ctx({ COLORTERM: '24bit', TERM: 'xterm' })), 'truecolor');
});

test('TERM *256color* without COLORTERM yields ansi256', () => {
  assert.equal(detectColorSupport(ctx({ TERM: 'xterm-256color' })), 'ansi256');
});

test('TERM=dumb yields none', () => {
  assert.equal(detectColorSupport(ctx({ TERM: 'dumb' })), 'none');
});

test('TERM=xterm yields ansi16', () => {
  assert.equal(detectColorSupport(ctx({ TERM: 'xterm' })), 'ansi16');
});

test('empty env + non-TTY falls back to none (piped without hints)', () => {
  assert.equal(detectColorSupport(ctx({}, false)), 'none');
});

test('empty env + TTY falls back to ansi16', () => {
  // A TTY with no env hints whatsoever — 16 colors is the safe minimum.
  assert.equal(detectColorSupport(ctx({}, true)), 'ansi16');
});

test('detectPalette default = rag (vivid)', () => {
  assert.equal(detectPalette(ctx({})), 'rag');
});

test('detectPalette honours SETPOINT_PALETTE=cividis', () => {
  assert.equal(detectPalette(ctx({ SETPOINT_PALETTE: 'cividis' })), 'cividis');
  assert.equal(detectPalette(ctx({ SETPOINT_PALETTE: 'CIVIDIS' })), 'cividis');
});

test('detectPalette falls back to rag for unknown values', () => {
  assert.equal(detectPalette(ctx({ SETPOINT_PALETTE: 'solarized' })), 'rag');
});

test('useNerdGlyphs respects SETPOINT_NERD truthy values', () => {
  assert.equal(useNerdGlyphs(ctx({ SETPOINT_NERD: '1' })), true);
  assert.equal(useNerdGlyphs(ctx({ SETPOINT_NERD: 'true' })), true);
  assert.equal(useNerdGlyphs(ctx({ SETPOINT_NERD: '0' })), false);
  assert.equal(useNerdGlyphs(ctx({ SETPOINT_NERD: 'no' })), false);
  assert.equal(useNerdGlyphs(ctx({})), false);
});

test('usePlainGlyphs respects SETPOINT_PLAIN', () => {
  assert.equal(usePlainGlyphs(ctx({ SETPOINT_PLAIN: '1' })), true);
  assert.equal(usePlainGlyphs(ctx({})), false);
});
