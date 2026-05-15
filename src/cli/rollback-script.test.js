import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLI_ENTRY } from './doctor.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ROLLBACK = join(REPO, 'scripts', 'rollback.sh');
const SANDBOXES = [];

afterEach(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-rollback-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  const binDir = join(dir, 'bin');
  const installDir = join(dir, 'install-root');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(installDir, 'src', 'cli'), { recursive: true });
  writeFileSync(join(installDir, 'package.json'), '{}\n');
  writeFileSync(join(installDir, 'src', 'cli', 'index.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { command: `node ${CLI_ENTRY}` },
  }));
  writeFileSync(join(claudeDir, 'settings.json.bak.1'), JSON.stringify({
    statusLine: { command: 'old' },
  }));
  return { dir, claudeDir, binDir, installDir };
}

function runRollback(s) {
  return spawnSync('bash', [ROLLBACK], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: s.claudeDir,
      CLAUDE_OPS_BIN_DIR: s.binDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
    },
  });
}

test('rollback restores settings backup and removes owned CLI launcher only', () => {
  const s = sandbox();
  writeFileSync(join(s.binDir, 'claude-ops'), `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='${CLI_ENTRY}'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`);

  const result = runRollback(s);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(s.binDir, 'claude-ops')), false);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.statusLine.command, 'old');
});

test('rollback leaves a non-owned claude-ops symlink intact', () => {
  const s = sandbox();
  symlinkSync('/tmp/some-other-claude-ops', join(s.binDir, 'claude-ops'));

  const result = runRollback(s);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(join(s.binDir, 'claude-ops')).isSymbolicLink(), true);
});

test('rollback removes the managed install root discovered from an owned launcher', () => {
  const s = sandbox();
  writeFileSync(join(s.binDir, 'claude-ops'), `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='${join(s.installDir, 'src', 'cli', 'index.js')}'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`);

  const result = runRollback(s);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(s.installDir), false);
});
