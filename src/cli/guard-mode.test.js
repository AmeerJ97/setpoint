import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from './guard-mode.js';
import { configureGuardMode, guardPaths } from '../guard/mode-control.js';

const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const SANDBOXES = [];

afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('guard mode audit removes disabled flag without requiring systemctl in tests', () => {
  const s = sandbox();
  const paths = guardPaths(s.env);
  mkdirSync(paths.pluginDir, { recursive: true });
  writeFileSync(paths.disabledFlag, '');

  const result = configureGuardMode('audit', s.env);

  assert.equal(result.ok, true);
  assert.equal(result.guard.mode, 'audit');
  assert.equal(exists(paths.disabledFlag), false);
});

test('guard mode disabled creates disabled flag', () => {
  const s = sandbox();
  const result = configureGuardMode('disabled', s.env);
  const paths = guardPaths(s.env);

  assert.equal(result.ok, true);
  assert.equal(result.guard.mode, 'disabled');
  assert.equal(exists(paths.disabledFlag), true);
});

test('guard mode enforce clears disabled flag and reports pending enforcement when systemctl is skipped', () => {
  const s = sandbox();
  const paths = guardPaths(s.env);
  mkdirSync(paths.pluginDir, { recursive: true });
  writeFileSync(paths.disabledFlag, '');

  const result = configureGuardMode('enforce', s.env);

  assert.equal(result.ok, true);
  assert.equal(result.guard.mode, 'audit');
  assert.equal(exists(paths.disabledFlag), false);
  assert.match(result.detail, /systemctl skipped/i);
});

test('guard mode CLI supports json status output', () => {
  const s = sandbox();
  let out = '';
  const original = process.stdout.write;
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try {
    const code = main(['mode', '--json'], { env: s.env });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.guard.mode, 'audit');
  } finally {
    process.stdout.write = original;
  }
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-guard-mode-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  const systemdDir = join(dir, 'systemd-user');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), '{}\n');
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  return {
    dir,
    env: {
      ...process.env,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_OPS_SYSTEMD_USER_DIR: systemdDir,
    },
  };
}

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
