import test from 'node:test';
import assert from 'node:assert/strict';
import { augmentTokenStats, computeDaemonStaleSec } from './runtime.js';

test('computeDaemonStaleSec returns null for fresh cache timestamps', () => {
  const now = Date.now();
  const fresh = new Date(now - 10_000).toISOString();
  const value = computeDaemonStaleSec(fresh);
  assert.equal(value, null);
});

test('computeDaemonStaleSec returns age seconds for stale cache timestamps', () => {
  const old = new Date(Date.now() - 120_000).toISOString();
  const value = computeDaemonStaleSec(old);
  assert.equal(typeof value, 'number');
  assert.ok(value >= 100);
});

test('augmentTokenStats keeps the freshest counters and computes burn fields', () => {
  const cached = {
    totalInput: 100,
    totalOutput: 50,
    totalCacheCreate: 0,
    totalCacheRead: 0,
    apiCalls: 1,
    burnRate: 10,
    tools: {},
    mcps: {},
    agentSpawns: 0,
    durationMin: 2,
    recentTurnsOutput: [20, 30],
  };

  const stdin = {
    context_window: {
      current_usage: {
        input_tokens: 120,
        output_tokens: 70,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
      },
    },
  };

  const result = augmentTokenStats(cached, stdin, null, 'claude-opus-4-7', new Date().toISOString());
  assert.equal(result.totalInput, 120);
  assert.equal(result.totalOutput, 70);
  assert.equal(result.totalCacheCreate, 30);
  assert.equal(result.totalCacheRead, 40);
  assert.equal(result.durationMin, 2);
  assert.equal(typeof result.burnRate, 'number');
  assert.equal(typeof result.burnRateSmoothed, 'number');
  assert.equal(result.burnRateModel, 'claude-opus-4-7');
});
