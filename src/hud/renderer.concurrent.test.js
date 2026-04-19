/*
 * Two-session end-to-end test. Simulates a daemon cycle that has
 * written per-session token stats for sid-A and sid-B, then invokes
 * the renderer twice with stdin payloads for each session. Asserts
 * the HUD output contains that session's distinctive token numbers
 * and NOT the other session's.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, 'renderer.js');
const SANDBOX = mkdtempSync(join(tmpdir(), 'setpoint-concurrent-'));
const CLAUDE_DIR = join(SANDBOX, '.claude');

before(() => {
  // Mirror the path helpers: PLUGIN_DIR = <CLAUDE_DIR>/plugins/claude-hud/
  const pluginDir = join(CLAUDE_DIR, 'plugins', 'claude-hud');
  const tokenDir  = join(pluginDir, 'token-stats');
  mkdirSync(tokenDir, { recursive: true });

  // Values chosen so formatTokens rounds unambiguously and the two
  // sessions produce distinctive "in:XXk" strings that can't collide.
  writeFileSync(join(tokenDir, 'sid-A.json'), JSON.stringify({
    sid: 'sid-A', totalInput: 12_000, totalOutput: 2_000, apiCalls: 3,
    totalCacheCreate: 0, totalCacheRead: 0, tools: {}, mcps: {},
    durationMin: 1,
  }));
  writeFileSync(join(tokenDir, 'sid-B.json'), JSON.stringify({
    sid: 'sid-B', totalInput: 80_000, totalOutput: 9_000, apiCalls: 9,
    totalCacheCreate: 0, totalCacheRead: 0, tools: {}, mcps: {},
    durationMin: 1,
  }));
});
after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function renderFor(sid) {
  const stdin = JSON.stringify({
    session_id: sid,
    transcript_path: '',
    cwd: SANDBOX,
    model: { display_name: 'Opus 4.7', id: 'claude-opus-4-7' },
    context_window: {
      context_window_size: 200_000,
      used_percentage: 10,
      current_usage: {
        input_tokens: 100, output_tokens: 50,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 5,  resets_at: null },
      seven_day: { used_percentage: 3,  resets_at: null },
    },
  });

  const r = spawnSync('node', [RENDERER], {
    input: stdin,
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_DIR },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`renderer exited ${r.status}: ${r.stderr}`);
  // Strip ANSI so substring checks are stable.
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

test('session A sees A\'s token totals, not B\'s', () => {
  const out = renderFor('sid-A');
  assert.match(out, /in:12K/, 'sees A total input (12K)');
  assert.doesNotMatch(out, /in:80K/, 'must not see B total input');
});

test('session B sees B\'s token totals, not A\'s', () => {
  const out = renderFor('sid-B');
  assert.match(out, /in:80K/, 'sees B total input (80K)');
  assert.doesNotMatch(out, /in:12K/, 'must not see A total input');
});
