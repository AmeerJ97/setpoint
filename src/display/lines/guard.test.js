import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderGuardLine } from './guard.js';
import { resetDefaultsCache } from '../../data/defaults.js';

// Strip ANSI for readable assertions.
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

afterEach(() => {
  delete process.env.CLAUDE_HUD_DEFAULTS_FILE;
  resetDefaultsCache();
});

test('guard DOWN state shows inventory and systemctl hint', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: false },
  }));
  assert.match(line, /✗ DOWN/);
  assert.match(line, /17 unprotected/);
  assert.match(line, /systemctl --user start claude-quality-guard/);
});

test('all categories held (no skips, no activations) shows ✓17/17 quiet', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 0,
      lastActivation: null,
      lastFlag: null,
    },
  }));
  assert.match(line, /✓17\/17/);
  assert.match(line, /quiet/);
  assert.doesNotMatch(line, / held/, 'redundant "held" text dropped');
  // R:E badge only renders when there's read/edit activity. None in this fixture.
  assert.doesNotMatch(line, /R:E/, 'no R:E without tool activity');
});

test('skipped categories render as a first-class state', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 3,
      activationsToday: 0,
      lastActivation: null,
      lastFlag: null,
    },
  }));
  assert.match(line, /◐14\/17/);
  assert.match(line, /○3 skipped/);
});

test('activations collapse into a single "↻N today (last:X Nm)" field', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 7,
      lastActivation: new Date(Date.now() - 2 * 60_000),
      lastFlag: 'brevity',
      topFlag: 'summarize',
      flagCounts: { brevity: 5, summarize: 2 },
    },
  }));
  assert.match(line, /↻7 today \(last:brevity 2m\)/);
  // top: dropped — ribbon encodes frequency now.
  assert.doesNotMatch(line, /top:/);
});

test('narrow layout keeps the collapsed activity field and the one-char ribbon digest', () => {
  // `brevity` maps to the `swann_brevity` flag head, so a lastFlag of
  // `swann_brevity` is a known-category revert → ▲ digest.
  const line = strip(renderGuardLine({
    narrow: true,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 2,
      lastActivation: new Date(),
      lastFlag: 'swann_brevity',
      topFlag: 'summarize',
      flagCounts: { swann_brevity: 2 },
    },
  }));
  assert.doesNotMatch(line, /top:/);
  assert.match(line, /↻2/);
  // Narrow ribbon collapses to a single-char digest (▲ or a shade) so the
  // heatmap signal stays visible below the 100-col cut.
  assert.match(line, /▲/, 'expected ▲ digest for most-recently-reverted flag');
  assert.doesNotMatch(line, /█{17}|▇{2,}/, 'no 17-wide ribbon in narrow mode');
});

test('total category count is read live from defaults.json (Phase 1.5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hud-guard-cats-'));
  const file = join(dir, 'defaults.json');
  // 5 categories, not 17 — display must reflect this.
  writeFileSync(file, JSON.stringify({
    guard: {
      categories: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' },
    },
  }));
  process.env.CLAUDE_HUD_DEFAULTS_FILE = file;
  resetDefaultsCache();

  try {
    const line = strip(renderGuardLine({
      narrow: false,
      guardStatus: { running: true, skippedCount: 0, activationsToday: 0 },
    }));
    assert.match(line, /✓5\/5/);
    assert.doesNotMatch(line, /17/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('falls back to 17 when defaults.json has no guard.categories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hud-guard-empty-'));
  const file = join(dir, 'defaults.json');
  writeFileSync(file, JSON.stringify({ unrelated: true }));
  process.env.CLAUDE_HUD_DEFAULTS_FILE = file;
  resetDefaultsCache();

  try {
    const line = strip(renderGuardLine({
      narrow: false,
      guardStatus: { running: false },
    }));
    assert.match(line, /17 unprotected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('17-glyph ribbon renders one cell per category in wide mode', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      skippedCategories: [],
      activationsToday: 0,
      flagCounts: {},
    },
  }));
  // 17 full blocks, all green.
  assert.match(line, /█{17}/);
});

test('17-glyph ribbon dims skipped category cells', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 2,
      skippedCategories: ['brevity', 'thinking'],
      activationsToday: 0,
      flagCounts: {},
    },
  }));
  // 1 chip ○ + 2 ribbon ○ = 3 total.
  const ringCount = (line.match(/○/g) ?? []).length;
  assert.equal(ringCount, 3, `expected 3 ○ glyphs (1 chip + 2 ribbon), got ${ringCount}`);
  // The ribbon spans exactly 17 cells: 15 █ + 2 ○.
  const fullCells = (line.match(/█/g) ?? []).length;
  assert.equal(fullCells, 15, `ribbon should have 15 held cells, got ${fullCells}`);
});

test('17-glyph ribbon highlights only the most-recently-reverted category with ▲', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      skippedCategories: [],
      activationsToday: 3,
      lastActivation: new Date(),
      lastFlag: 'pewter_kestrel.global',
      flagCounts: { 'pewter_kestrel.global': 2, 'swann_brevity': 1 },
    },
  }));
  const triangleCount = (line.match(/▲/g) ?? []).length;
  // Most-recent wins ▲; other reverted categories render as shaded glyphs.
  assert.equal(triangleCount, 1, `expected exactly 1 ▲ (most-recent), got ${triangleCount}`);
  // swann_brevity had 1 revert → green ▇ shade in the ribbon.
  assert.match(line, /▇/, 'expected ▇ shade for the 1-revert category');
});

test('ribbon shade darkens with revert count', () => {
  const baseGuard = {
    running: true,
    skippedCount: 0,
    skippedCategories: [],
    activationsToday: 99,
    lastActivation: new Date(),
    lastFlag: 'unrelated_flag_not_mapped',  // keep ▲ off the ribbon so shades dominate
  };

  // 0 reverts — all █, no darker shade.
  const l0 = strip(renderGuardLine({
    narrow: false,
    guardStatus: { ...baseGuard, flagCounts: {} },
  }));
  assert.doesNotMatch(l0, /[▇▆▅▄]/);
  assert.match(l0, /█/);

  // 1 revert on `brevity` → one ▇ glyph.
  const l1 = strip(renderGuardLine({
    narrow: false,
    guardStatus: { ...baseGuard, flagCounts: { swann_brevity: 1 } },
  }));
  assert.match(l1, /▇/);

  // 2 reverts → ▆.
  const l2 = strip(renderGuardLine({
    narrow: false,
    guardStatus: { ...baseGuard, flagCounts: { swann_brevity: 2 } },
  }));
  assert.match(l2, /▆/);

  // 4 reverts → ▅.
  const l4 = strip(renderGuardLine({
    narrow: false,
    guardStatus: { ...baseGuard, flagCounts: { swann_brevity: 4 } },
  }));
  assert.match(l4, /▅/);

  // 8 reverts → ▄ (red-class).
  const l8 = strip(renderGuardLine({
    narrow: false,
    guardStatus: { ...baseGuard, flagCounts: { swann_brevity: 8 } },
  }));
  assert.match(l8, /▄/);
});

test('17-glyph ribbon is suppressed in narrow mode (digest replaces it)', () => {
  const line = strip(renderGuardLine({
    narrow: true,
    guardStatus: {
      running: true,
      skippedCount: 0,
      skippedCategories: [],
      activationsToday: 0,
      flagCounts: {},
    },
  }));
  // No 17-wide ribbon, but a single █ digest stays visible so the affordance
  // doesn't disappear in narrow mode.
  assert.doesNotMatch(line, /█{17}/);
  assert.match(line, /█/, 'digest renders a single cell');
});

test('R:E badge renders on Guard line wide mode with counts and status', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true, skippedCount: 0, activationsToday: 0, flagCounts: {},
    },
    toolCounts: { Read: 28, Edit: 7 },
  }));
  assert.match(line, /R:E 4\.0 \(28r\/7e\) healthy/);
});

test('R:E badge yellow on ok band, red on degraded band', () => {
  const ok = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: true, skippedCount: 0, activationsToday: 0, flagCounts: {} },
    toolCounts: { Read: 5, Edit: 2 },  // ratio 2.5 → between WARN(2.0) and HEALTHY(3.0)
  }));
  assert.match(ok, /R:E 2\.5 \(5r\/2e\) ok/);

  const bad = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: true, skippedCount: 0, activationsToday: 0, flagCounts: {} },
    toolCounts: { Read: 4, Edit: 7 },  // ratio 0.57 → degraded
  }));
  assert.match(bad, /R:E 0\.6 \(4r\/7e\) degraded/);
});

test('R:E badge prefers advisory.metrics over raw toolCounts when present', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: true, skippedCount: 0, activationsToday: 0, flagCounts: {} },
    advisory: { metrics: { reads: 50, edits: 10, ratio: 5.0 } },
    toolCounts: { Read: 1, Edit: 1 },
  }));
  assert.match(line, /R:E 5\.0 \(50r\/10e\) healthy/);
});

test('R:E badge narrow mode drops counts and status word', () => {
  const line = strip(renderGuardLine({
    narrow: true,
    guardStatus: { running: true, skippedCount: 0, activationsToday: 0, flagCounts: {} },
    toolCounts: { Read: 28, Edit: 7 },
  }));
  assert.match(line, /R:E 4\.0/);
  assert.doesNotMatch(line, /\(28r\/7e\)/);
  assert.doesNotMatch(line, /healthy/);
});

test('R:E badge renders dim when edits=0 (no division-by-zero confusion)', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: true, skippedCount: 0, activationsToday: 0, flagCounts: {} },
    toolCounts: { Read: 5, Edit: 0 },
  }));
  assert.match(line, /R:E -- \(5r\/0e\)/);
});
