import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTokensLine } from './tokens.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const baseStdin = {
  model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
  context_window: { context_window_size: 200_000 },
};

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

test('cache % falls back to cumulative with cache* label when series too short', () => {
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
  assert.match(line, /cache\*:.* 80%/);
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
  }));
  assert.doesNotMatch(line, /5m|1h|only/);
});
