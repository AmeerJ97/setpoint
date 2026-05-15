import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContextLine } from './context.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const baseStdin = {
  context_window: {
    context_window_size: 200_000,
    used_percentage: 30,
    current_usage: {
      input_tokens: 10_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
};

test('Context line stays focused on context pressure, not cache layers', () => {
  const line = strip(renderContextLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalCacheRead: 120_000,
      totalCacheCreate: 40_000,
      totalCacheCreate5m: 0,
      totalCacheCreate1h: 40_000,
    },
    rtkStats: {
      totalSaved: 42_000,
      avgSavingsPct: 88,
      totalCommands: 12,
      mtimeMs: Date.now(),
    },
    rtkStatus: { state: 'saving' },
  }));

  assert.match(line, /Context\s+/);
  assert.match(line, /30%/);
  assert.match(line, /\(10K\/200K\)/);
  assert.doesNotMatch(line, /native:/);
  assert.doesNotMatch(line, /rtk:/);
  assert.doesNotMatch(line, /cache:/);
});

test('Context line does not show write-only native cache startup', () => {
  const line = strip(renderContextLine({
    narrow: false,
    stdin: {
      context_window: {
        context_window_size: 200_000,
        used_percentage: 10,
        current_usage: {
          input_tokens: 10_000,
          cache_creation_input_tokens: 12_000,
          cache_read_input_tokens: 0,
        },
      },
    },
    tokenStats: {
      totalCacheRead: 0,
      totalCacheCreate: 12_000,
      totalCacheCreate5m: 12_000,
      totalCacheCreate1h: 0,
    },
    rtkStats: null,
    rtkStatus: { state: 'off' },
  }));

  assert.match(line, /10%/);
  assert.doesNotMatch(line, /native:/);
  assert.doesNotMatch(line, /rtk:/);
  assert.doesNotMatch(line, /cache:/);
});

test('Context line omits disabled and stale RTK states', () => {
  const disabled = strip(renderContextLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {},
    rtkStats: null,
    rtkStatus: { state: 'disabled' },
  }));
  assert.doesNotMatch(disabled, /native:/);
  assert.doesNotMatch(disabled, /rtk:/);

  const stale = strip(renderContextLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {},
    rtkStats: {
      totalSaved: 10_000,
      avgSavingsPct: 55,
      totalCommands: 2,
      mtimeMs: Date.now() - 11 * 60_000,
    },
    rtkStatus: { state: 'stale' },
  }));
  assert.doesNotMatch(stale, /native:/);
  assert.doesNotMatch(stale, /rtk:/);
});
