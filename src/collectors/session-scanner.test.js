/*
 * Per-session token-stats scoping tests. paths.js caches CLAUDE_DIR on
 * first load, so we set CLAUDE_CONFIG_DIR before any import of the
 * module graph and reuse one sandbox across tests with distinct
 * session ids per case.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'setpoint-scanner-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');

// Import *after* the env var is set so paths.js captures the sandbox.
const paths = await import('../data/paths.js');
const scanner = await import('./session-scanner.js');
const stdin = await import('../data/stdin.js');

before(() => {
  mkdirSync(paths.TOKEN_STATS_DIR, { recursive: true });
  mkdirSync(paths.PLUGIN_DIR,       { recursive: true });
});
after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

test('per-session cache returns only that session\'s stats', () => {
  const sidA = 'case1-session-a';
  const sidB = 'case1-session-b';

  writeFileSync(paths.tokenStatsFileFor(sidA), JSON.stringify({
    sid: sidA, totalInput: 1000, totalOutput: 500, apiCalls: 10,
    totalCacheCreate: 0, totalCacheRead: 0, tools: { Read: 3 }, mcps: {},
    durationMin: 5,
  }));
  writeFileSync(paths.tokenStatsFileFor(sidB), JSON.stringify({
    sid: sidB, totalInput: 9000, totalOutput: 9000, apiCalls: 99,
    totalCacheCreate: 0, totalCacheRead: 0, tools: { Edit: 7 }, mcps: {},
    durationMin: 30,
  }));

  const statsA = scanner.readCachedTokenStats(sidA);
  const statsB = scanner.readCachedTokenStats(sidB);
  assert.equal(statsA.totalInput, 1000, 'session A sees only A');
  assert.equal(statsB.totalInput, 9000, 'session B sees only B');
  assert.deepEqual(Object.keys(statsA.tools), ['Read']);
  assert.deepEqual(Object.keys(statsB.tools), ['Edit']);
  assert.notEqual(statsA.totalInput, statsB.totalInput);
});

test('legacy aggregate fallback when per-session file absent', () => {
  writeFileSync(paths.TOKEN_STATS_LATEST, JSON.stringify({
    scannedAt: new Date().toISOString(),
    sessions: [
      { sid: 'case2-old-1', totalInput: 100, totalOutput: 50, tools: {}, mcps: {}, dur: 1 },
      { sid: 'case2-old-2', totalInput: 200, totalOutput: 70, tools: {}, mcps: {}, dur: 2 },
    ],
  }));

  const stats = scanner.readCachedTokenStats('case2-new-session-no-file');
  assert.equal(stats.totalInput, 300);
  assert.equal(stats.totalOutput, 120);
});

test('legacy fallback matches by sid when possible', () => {
  writeFileSync(paths.TOKEN_STATS_LATEST, JSON.stringify({
    scannedAt: new Date().toISOString(),
    sessions: [
      { sid: 'case3-match',  totalInput: 42,  totalOutput: 7,  tools: {}, mcps: {}, dur: 1 },
      { sid: 'case3-ignore', totalInput: 999, totalOutput: 999, tools: {}, mcps: {}, dur: 1 },
    ],
  }));

  const stats = scanner.readCachedTokenStats('case3-match');
  assert.equal(stats.totalInput, 42, 'matches by sid inside legacy blob');
  assert.equal(stats.totalOutput, 7);
});

test('getActiveMcpNames is scoped by sessionId', () => {
  writeFileSync(paths.tokenStatsFileFor('case4-s1'), JSON.stringify({
    sid: 'case4-s1', tools: {}, mcps: { brave: 3, sentry: 1 },
  }));
  writeFileSync(paths.tokenStatsFileFor('case4-s2'), JSON.stringify({
    sid: 'case4-s2', tools: {}, mcps: { perplexity: 5 },
  }));

  assert.deepEqual(scanner.getActiveMcpNames('case4-s1'), ['brave', 'sentry']);
  assert.deepEqual(scanner.getActiveMcpNames('case4-s2'), ['perplexity']);
});

test('getSessionId: explicit field preferred, transcript_path fallback, null when missing', () => {
  assert.equal(stdin.getSessionId({ session_id: 'explicit' }), 'explicit');
  assert.equal(
    stdin.getSessionId({ transcript_path: '/x/y/abcd1234-5678.jsonl' }),
    'abcd1234-5678',
  );
  assert.equal(stdin.getSessionId({}), null);
  assert.equal(stdin.getSessionId(null), null);
  assert.equal(stdin.getSessionId(undefined), null);
});
