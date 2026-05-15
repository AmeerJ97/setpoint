import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLI = join(REPO, 'src', 'cli', 'index.js');
const SANDBOXES = [];

afterEach(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-effort-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  return { dir, claudeDir };
}

function runEffort(args, s, extraEnv = {}) {
  return spawnSync('node', [CLI, 'effort', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_CONFIG_DIR: s.claudeDir,
      CLAUDE_OPS_CLAUDE_JSON_PATH: join(s.dir, '.claude.json'),
    },
  });
}

test('effort status reports settings hook mode and session-only max', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    effortLevel: 'xhigh',
    claudeOps: { hookMode: 'advisory' },
  }));

  const result = runEffort(['--json'], s, { CLAUDE_CODE_EFFORT_LEVEL: 'max' });

  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.effortLevel, 'xhigh');
  assert.equal(json.sessionEffortLevel, 'max');
  assert.equal(json.hookMode, 'advisory');
});

test('effort refuses to persist max', () => {
  const s = sandbox();
  const result = runEffort(['max'], s);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid level 'max'/);
});

test('effort default removes persisted effortLevel', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    effortLevel: 'high',
    claudeOps: { hookMode: 'blocking' },
  }));

  const result = runEffort(['default', '--json'], s);

  assert.equal(result.status, 0, result.stderr);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal('effortLevel' in settings, false);
});
