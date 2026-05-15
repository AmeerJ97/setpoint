import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderTokensLine } from './tokens.js';
import { setColorMode } from '../colors.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const baseStdin = {
  model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
  context_window: { context_window_size: 200_000 },
};

afterEach(() => setColorMode(null));

test('rolling 10-turn cache % overrides session-cumulative when series available', () => {
  // Session-cumulative would compute 1000/(9000+1000) = 10%.
  // Rolling 10-turn has reads=900, writes=100 → 90%.
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 1000, totalOutput: 500,
      totalCacheCreate: 9000, totalCacheRead: 1000,
      totalCacheCreate5m: 0, totalCacheCreate1h: 9000,
      apiCalls: 5, durationMin: 5, burnRate: 100,
      recentTurnsCacheRead: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
      recentTurnsCacheCreate: [10, 10, 10, 10, 10, 10, 10, 10, 10, 20],
    },
  }));
  assert.match(line, /cache:.* 90%/);
});

test('cache % falls back to cumulative with cache-hist label when series too short', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 1000, totalOutput: 500,
      totalCacheCreate: 1000, totalCacheRead: 4000,
      apiCalls: 5, durationMin: 5, burnRate: 100,
      recentTurnsCacheRead: [],
      recentTurnsCacheCreate: [],
    },
  }));
  assert.match(line, /cache-hist:.* 80%/);
});

test('TTL split shows 5m only when all writes land in 5m tier (#46829 signal)', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 0, totalOutput: 100,
      totalCacheCreate: 50_000, totalCacheRead: 100_000,
      totalCacheCreate5m: 50_000, totalCacheCreate1h: 0,
      apiCalls: 5, durationMin: 5, burnRate: 100,
      recentTurnsCacheRead: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      recentTurnsCacheCreate: [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000],
    },
  }));
  assert.match(line, /\(5m only\)/);
});

test('TTL split shows 1h only when ENABLE_PROMPT_CACHING_1H is honored', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 0, totalOutput: 100,
      totalCacheCreate: 50_000, totalCacheRead: 100_000,
      totalCacheCreate5m: 0, totalCacheCreate1h: 50_000,
      apiCalls: 5, durationMin: 5, burnRate: 100,
      recentTurnsCacheRead: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      recentTurnsCacheCreate: [5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000],
    },
  }));
  assert.match(line, /\(1h only\)/);
});

test('TTL split shows mixed ratios when both tiers see writes', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 0, totalOutput: 100,
      totalCacheCreate: 100_000, totalCacheRead: 100_000,
      totalCacheCreate5m: 30_000, totalCacheCreate1h: 70_000,
      apiCalls: 5, durationMin: 5, burnRate: 100,
      recentTurnsCacheRead: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
      recentTurnsCacheCreate: [10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
    },
  }));
  assert.match(line, /\(5m:30%\/1h:70%\)/);
});

test('Tokens line shows native cache and RTK saving as first-class indicators', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 42_000,
      totalOutput: 10_000,
      totalCacheRead: 120_000,
      totalCacheCreate: 40_000,
      totalCacheCreate5m: 0,
      totalCacheCreate1h: 40_000,
      apiCalls: 8,
      durationMin: 20,
      burnRate: 100,
    },
    rtkStats: {
      totalSaved: 42_000,
      avgSavingsPct: 88,
      totalCommands: 12,
      mtimeMs: Date.now(),
    },
    rtkStatus: { state: 'saving' },
    promptCacheConfig: { mode: '5m' },
  }));

  assert.match(line, /native:on 1h/);
  assert.match(line, /cfg:5m/);
  assert.match(line, /rtk:saving 42K↓88%/);
});

test('Tokens line distinguishes native cache write-only startup from cache hits', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: {
      ...baseStdin,
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          cache_creation_input_tokens: 12_000,
          cache_read_input_tokens: 0,
        },
      },
    },
    tokenStats: {
      totalInput: 0,
      totalOutput: 100,
      totalCacheRead: 0,
      totalCacheCreate: 12_000,
      totalCacheCreate5m: 12_000,
      totalCacheCreate1h: 0,
      apiCalls: 1,
      durationMin: 1,
      burnRate: 100,
    },
    rtkStats: null,
    rtkStatus: { state: 'off' },
    promptCacheConfig: { mode: '5m' },
  }));

  assert.match(line, /native:write 5m/);
  assert.match(line, /cfg:5m/);
  assert.match(line, /rtk:off/);
});

test('native cache note does not double-count current_usage when tokenStats is present', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: {
      ...baseStdin,
      context_window: {
        context_window_size: 200_000,
        current_usage: {
          cache_creation_input_tokens: 90_000,
          cache_read_input_tokens: 10_000,
        },
      },
    },
    tokenStats: {
      totalInput: 0,
      totalOutput: 100,
      totalCacheRead: 0,
      totalCacheCreate: 12_000,
      totalCacheCreate5m: 12_000,
      totalCacheCreate1h: 0,
      apiCalls: 1,
      durationMin: 1,
      burnRate: 100,
    },
    rtkStatus: { state: 'off' },
  }));

  assert.match(line, /native:write 5m/);
  assert.doesNotMatch(line, /native:on/);
});

test('Tokens line shows disabled and stale RTK states explicitly', () => {
  const disabled = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: { totalInput: 0, totalOutput: 0, apiCalls: 0, durationMin: 0, burnRate: 0 },
    rtkStats: null,
    rtkStatus: { state: 'disabled' },
    promptCacheConfig: { mode: '5m' },
  }));
  assert.match(disabled, /native:idle/);
  assert.match(disabled, /cfg:5m/);
  assert.match(disabled, /rtk:disabled/);

  const stale = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: { totalInput: 0, totalOutput: 0, apiCalls: 0, durationMin: 0, burnRate: 0 },
    rtkStats: {
      totalSaved: 10_000,
      avgSavingsPct: 55,
      totalCommands: 2,
      mtimeMs: Date.now() - 11 * 60_000,
    },
    rtkStatus: { state: 'stale' },
    promptCacheConfig: { mode: '5m' },
  }));
  assert.match(stale, /rtk:stale 10K/);
});

test('Tokens line shows configured 1h cache policy explicitly', () => {
  const old = process.env.ENABLE_PROMPT_CACHING_1H;
  process.env.ENABLE_PROMPT_CACHING_1H = '1';
  try {
    const line = strip(renderTokensLine({
      narrow: false,
      stdin: { model: { id: 'claude-haiku-4-5@20251001', display_name: 'Haiku 4.5' }, context_window: { context_window_size: 200_000 } },
      tokenStats: { totalInput: 1, totalOutput: 1, apiCalls: 1, durationMin: 1, burnRate: 1 },
      rtkStatus: { state: 'off' },
    }));
    assert.match(line, /cfg:1h/);
  } finally {
    if (old === undefined) delete process.env.ENABLE_PROMPT_CACHING_1H;
    else process.env.ENABLE_PROMPT_CACHING_1H = old;
  }
});

test('no TTL split overlay when no cache_create activity', () => {
  const line = strip(renderTokensLine({
    narrow: false,
    stdin: baseStdin,
    tokenStats: {
      totalInput: 100, totalOutput: 100,
      totalCacheCreate: 0, totalCacheRead: 0,
      totalCacheCreate5m: 0, totalCacheCreate1h: 0,
      apiCalls: 1, durationMin: 1, burnRate: 100,
      recentTurnsCacheRead: [],
      recentTurnsCacheCreate: [],
    },
    promptCacheConfig: { mode: '5m' },
  }));
  assert.doesNotMatch(line, /\((?:5m|1h).*only\)/);
});
