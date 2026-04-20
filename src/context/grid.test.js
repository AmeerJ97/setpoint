import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chooseDimensions, buildCells, renderGrid, renderInlineGrid } from './grid.js';

function mkReport(overrides = {}) {
  return {
    buckets: [
      { name: 'System Prompt', tokens: 3_000,  source: 'baseline' },
      { name: 'System Tools',  tokens: 12_000, source: 'baseline' },
      { name: 'MCP Tools',     tokens: 0,      source: 'cache' },
      { name: 'Custom Agents', tokens: 5_000,  source: 'agents' },
      { name: 'Memory Files',  tokens: 4_000,  source: 'CLAUDE.md' },
      { name: 'Skills',        tokens: 0,      source: 'skills' },
      { name: 'Messages',      tokens: 50_000, source: 'jsonl' },
    ],
    totalTokens: 74_000,
    contextWindow: 200_000,
    freeSpace: 93_000,
    autocompactBuffer: 33_000,
    modelLabel: 'Claude Opus 4.7',
    approximate: true,
    ...overrides,
  };
}

test('chooseDimensions picks 10x10 for a 200K window in a wide terminal', () => {
  const d = chooseDimensions(200_000, 120);
  assert.equal(d.cols, 10);
  assert.equal(d.rows, 10);
  assert.equal(d.tokensPerCell, 2_000);
});

test('chooseDimensions picks 20x10 for a 1M window', () => {
  const d = chooseDimensions(1_000_000, 200);
  assert.equal(d.cols, 20);
  assert.equal(d.rows, 10);
  assert.equal(d.tokensPerCell, 5_000);
});

test('chooseDimensions falls back to 5x5 in very narrow terminals', () => {
  const d = chooseDimensions(200_000, 40);
  assert.equal(d.cols, 5);
  assert.equal(d.rows, 5);
});

test('buildCells fills exactly cols*rows cells', () => {
  const cells = buildCells(mkReport(), 10, 10, 2_000);
  assert.equal(cells.length, 100);
});

test('buildCells gives at least one cell to each non-empty bucket', () => {
  // Tiny bucket of 500 tokens — would round to 0 cells without the floor.
  const r = mkReport({
    buckets: [
      { name: 'System Prompt', tokens: 500,    source: 'baseline' },
      { name: 'System Tools',  tokens: 12_000, source: 'baseline' },
      { name: 'MCP Tools',     tokens: 0,      source: 'cache' },
      { name: 'Custom Agents', tokens: 0,      source: 'agents' },
      { name: 'Memory Files',  tokens: 0,      source: 'CLAUDE.md' },
      { name: 'Skills',        tokens: 0,      source: 'skills' },
      { name: 'Messages',      tokens: 0,      source: 'jsonl' },
    ],
  });
  const cells = buildCells(r, 10, 10, 2_000);
  assert.ok(cells.some(c => c.bucket === 'System Prompt'),
    'tiny System Prompt bucket must be visible');
});

test('renderGrid emits the expected number of grid rows', () => {
  const out = renderGrid(mkReport(), 120);
  // Body rows are 2-space indented and contain the cell glyphs separated by spaces.
  const gridRows = out.split('\n').filter(l => /^  \S/.test(l) && !/[A-Za-z]/.test(stripAnsi(l)));
  assert.equal(gridRows.length, 10);
});

test('renderGrid prints the legend with every bucket name', () => {
  const out = stripAnsi(renderGrid(mkReport(), 120));
  for (const name of ['System Prompt', 'System Tools', 'MCP Tools',
                      'Custom Agents', 'Memory Files', 'Skills',
                      'Messages', 'Free Space', 'Autocompact Buffer']) {
    assert.ok(out.includes(name), `legend missing ${name}`);
  }
});

test('renderGrid surfaces the approximate disclaimer', () => {
  const out = stripAnsi(renderGrid(mkReport(), 120));
  assert.match(out, /approximate/);
  assert.match(out, /native \/context is authoritative/);
});

test('renderInlineGrid returns 11 lines (title + 10 rows) by default', () => {
  const lines = renderInlineGrid(mkReport());
  assert.equal(lines.length, 11, `expected title + 10 grid rows, got ${lines.length}`);
});

test('renderInlineGrid returns 10 lines with noTitle', () => {
  const lines = renderInlineGrid(mkReport(), { noTitle: true });
  assert.equal(lines.length, 10);
});

test('renderInlineGrid body rows are exactly `cols` cells wide (tight packed)', () => {
  const lines = renderInlineGrid(mkReport(), { noTitle: true });
  // Each row should contain exactly 10 visible glyphs (no inter-cell spaces).
  for (const line of lines) {
    const visible = stripAnsi(line);
    assert.equal(visible.length, 10, `row '${visible}' is ${visible.length} chars, expected 10`);
  }
});

test('renderInlineGrid total cells across all rows equals cols*rows', () => {
  const lines = renderInlineGrid(mkReport(), { noTitle: true, cols: 10, rows: 10 });
  const cellCount = lines.reduce((acc, l) => acc + stripAnsi(l).length, 0);
  assert.equal(cellCount, 100);
});

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
