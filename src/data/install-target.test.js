import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  extractCliEntry,
  getDefaultInstallRoot,
  inspectOwnedLauncherInstall,
  inspectStatusLineInstall,
  isManagedInstallRoot,
  parseOwnedLauncherEntry,
  resolveInstallTarget,
  rootFromCliEntry,
} from './install-target.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SANDBOXES = [];

afterEach(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('explicit install env wins', () => {
  const env = { CLAUDE_OPS_INSTALL_DIR: '/tmp/claude-ops-live' };
  assert.equal(getDefaultInstallRoot(env), '/tmp/claude-ops-live');
  assert.deepEqual(resolveInstallTarget({ env, currentRepoRoot: REPO_ROOT }), {
    root: '/tmp/claude-ops-live',
    source: 'explicit-env',
  });
});

test('owned launcher root is preferred when it looks like a managed install', () => {
  const s = sandbox();
  const installedRoot = managedInstallRoot(s.dir, 'installed');
  const binDir = join(s.dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude-ops'), `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='${join(installedRoot, 'src', 'cli', 'index.js')}'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`);

  const info = inspectOwnedLauncherInstall({
    env: { CLAUDE_OPS_BIN_DIR: binDir },
    currentRepoRoot: REPO_ROOT,
  });

  assert.equal(info.source, 'owned-launcher');
  assert.equal(info.root, installedRoot);
  assert.equal(resolveInstallTarget({
    env: { CLAUDE_OPS_BIN_DIR: binDir },
    currentRepoRoot: REPO_ROOT,
  }).root, installedRoot);
});

test('statusLine install is used when launcher is absent and target is a managed copy', () => {
  const s = sandbox();
  const installedRoot = managedInstallRoot(s.dir, 'installed');
  const binDir = join(s.dir, 'bin');
  const settingsPath = join(s.dir, '.claude', 'settings.json');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { command: `node ${join(installedRoot, 'src', 'cli', 'index.js')}` },
  }));

  const info = inspectStatusLineInstall({ settingsPath, currentRepoRoot: REPO_ROOT });
  assert.equal(info.root, installedRoot);
  assert.deepEqual(resolveInstallTarget({
    env: { CLAUDE_OPS_BIN_DIR: binDir },
    settingsPath,
    currentRepoRoot: REPO_ROOT,
  }), {
    root: installedRoot,
    source: 'statusline-install',
  });
});

test('current checkout and git-backed roots are not treated as managed install copies', () => {
  const s = sandbox();
  const binDir = join(s.dir, 'bin');
  const settingsPath = join(s.dir, '.claude', 'settings.json');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { command: `node ${join(REPO_ROOT, 'src', 'cli', 'index.js')}` },
  }));

  assert.equal(isManagedInstallRoot(REPO_ROOT, { currentRepoRoot: REPO_ROOT }), false);
  assert.equal(inspectStatusLineInstall({ settingsPath, currentRepoRoot: REPO_ROOT }).root, null);
  assert.equal(resolveInstallTarget({
    env: { CLAUDE_OPS_BIN_DIR: binDir },
    settingsPath,
    currentRepoRoot: REPO_ROOT,
  }).source, 'default');
});

test('launcher parsing helpers remain stable', () => {
  const content = `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='/tmp/installed/src/cli/index.js'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`;
  assert.equal(parseOwnedLauncherEntry(content), '/tmp/installed/src/cli/index.js');
  assert.equal(rootFromCliEntry('/tmp/installed/src/cli/index.js'), '/tmp/installed');
  assert.equal(extractCliEntry('node /tmp/installed/src/cli/index.js --json'), '/tmp/installed/src/cli/index.js');
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-install-root-'));
  SANDBOXES.push(dir);
  return { dir };
}

function managedInstallRoot(base, name) {
  const root = join(base, name);
  mkdirSync(join(root, 'src', 'cli'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'src', 'cli', 'index.js'), '#!/usr/bin/env node\n');
  return root;
}
