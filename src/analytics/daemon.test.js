import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeSession } from './daemon.js';

function makeFixture(turns) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hud-test-'));
  const path = join(dir, 'session.jsonl');
  const lines = turns.map(t => JSON.stringify(t));
  writeFileSync(path, lines.join('\n'));
  return { path, dir };
}

test('peakContext is max per-turn (input+cacheRead+cacheCreate), not cumulative', () => {
  const { path, dir } = makeFixture([
    { type: 'assistant', timestamp: '2026-04-19T10:00:00Z', message: {
      model: 'claude-opus-4-7', usage: {
        input_tokens: 1_000, output_tokens: 100,
        cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000,
      },
    }},
    { type: 'assistant', timestamp: '2026-04-19T10:01:00Z', message: {
      model: 'claude-opus-4-7', usage: {
        input_tokens: 500, output_tokens: 200,
        cache_read_input_tokens: 80_000, cache_creation_input_tokens: 0,
      },
    }},
    { type: 'assistant', timestamp: '2026-04-19T10:02:00Z', message: {
      model: 'claude-opus-4-7', usage: {
        input_tokens: 300, output_tokens: 50,
        cache_read_input_tokens: 30_000, cache_creation_input_tokens: 0,
      },
    }},
  ]);

  try {
    const s = analyzeSession(path);
    // Turn 1 context: 1000 + 50_000 + 10_000 = 61_000
    // Turn 2 context: 500 + 80_000 + 0 = 80_500 ← peak
    // Turn 3 context: 300 + 30_000 + 0 = 30_300
    assert.equal(s.peakContext, 80_500, 'peakContext should be max per-turn prefill');
    // Cumulative cacheRead would be 160_000 — make sure we did not regress to that.
    assert.equal(s.totalCacheRead, 160_000);
    assert.notEqual(s.peakContext, s.totalCacheRead);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('peakContext is zero with no assistant turns', () => {
  const { path, dir } = makeFixture([
    { type: 'user', timestamp: '2026-04-19T10:00:00Z' },
  ]);
  try {
    const s = analyzeSession(path);
    assert.equal(s.peakContext, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('peakContext includes cache_create in the per-turn sum', () => {
  const { path, dir } = makeFixture([
    { type: 'assistant', timestamp: '2026-04-19T10:00:00Z', message: {
      model: 'claude-opus-4-7', usage: {
        input_tokens: 0, output_tokens: 0,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 42_000,
      },
    }},
  ]);
  try {
    const s = analyzeSession(path);
    assert.equal(s.peakContext, 42_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
