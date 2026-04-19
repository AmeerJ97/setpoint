import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGuardLine } from './guard.js';

// Strip ANSI for readable assertions.
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('guard DOWN state shows inventory and systemctl hint', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: { running: false },
  }));
  assert.match(line, /✗ DOWN/);
  assert.match(line, /17 unprotected/);
  assert.match(line, /systemctl --user start claude-quality-guard/);
});

test('all categories held (no skips, no activations) shows ✓17/17 held quiet', () => {
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
  assert.match(line, /✓17\/17 held/);
  assert.match(line, /quiet/);
  assert.doesNotMatch(line, /R:E/, 'R:E moved to Tokens line');
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
  assert.match(line, /◐14\/17 held/);
  assert.match(line, /○3 skipped/);
});

test('activations surface last-flag + count + top offender', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 7,
      lastActivation: new Date(Date.now() - 2 * 60_000),
      lastFlag: 'brevity',
      topFlag: 'summarize',
    },
  }));
  assert.match(line, /last:brevity 2m ago/);
  assert.match(line, /↻7 today/);
  assert.match(line, /top:summarize/);
});

test('top flag hidden when equal to last flag (avoid redundancy)', () => {
  const line = strip(renderGuardLine({
    narrow: false,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 2,
      lastActivation: new Date(),
      lastFlag: 'brevity',
      topFlag: 'brevity',
    },
  }));
  assert.doesNotMatch(line, /top:/);
});

test('narrow layout omits top-flag even when it would fit', () => {
  const line = strip(renderGuardLine({
    narrow: true,
    guardStatus: {
      running: true,
      skippedCount: 0,
      activationsToday: 2,
      lastActivation: new Date(),
      lastFlag: 'brevity',
      topFlag: 'summarize',
    },
  }));
  assert.doesNotMatch(line, /top:/);
  assert.match(line, /↻2/);
});
