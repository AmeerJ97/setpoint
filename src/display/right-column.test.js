import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderRightColumns } from './right-column.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function mkCtx(overrides = {}) {
  return {
    narrow: false,
    stdin: {
      model: { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7' },
      context_window: { context_window_size: 200_000, used_percentage: 0 },
      cwd: '/tmp',
      transcript_path: '',
    },
    usageData: null,
    tokenStats: null,
    guardStatus: { running: true, activationsToday: 0 },
    advisory: null,
    ...overrides,
  };
}

test('renderRightColumns returns the 8 summary rows', () => {
  const rows = renderRightColumns(mkCtx());
  // 8 summary rows always present; extras may push the total higher.
  assert.ok(rows.length >= 8, `expected >= 8 rows, got ${rows.length}`);
});

test('inline grid adds 10 body rows below the 8 summary rows', () => {
  const rows = renderRightColumns(mkCtx());
  // Summary is rows 0-7; then a blank spacer; then title + 10 grid rows.
  // Total: 8 + 1 + 11 = 20 rows in the default wide-mode layout.
  assert.equal(rows.length, 20, `expected 20 total rows (8 summary + spacer + title + 10 grid), got ${rows.length}`);
});

test('narrow mode drops the inline grid extras entirely', () => {
  const rows = renderRightColumns(mkCtx({ narrow: true }));
  assert.equal(rows.length, 8, 'narrow mode should return exactly 8 summary rows');
});

test('inline grid rows contain bucket glyphs', () => {
  const rows = renderRightColumns(mkCtx());
  const gridBody = rows.slice(-10); // last 10 rows = grid body
  const allText = gridBody.map(strip).join('');
  // System Tools uses ▓, Free Space uses ·, Autocompact Buffer uses ░.
  // At least one of these should appear in a default 200K/no-transcript render.
  assert.match(allText, /[▓·░█]/, 'grid body should contain bucket glyphs');
});
