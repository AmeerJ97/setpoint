import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CLI_ENTRY, RUST_GUARD_ENTRY } from './doctor.js';
import { repair } from './repair.js';

const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const SANDBOXES = [];

afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-repair-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  const systemdDir = join(dir, 'systemd-user');
  const binDir = join(dir, 'bin');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const env = {
    ...process.env,
    CLAUDE_OPS_SYSTEMD_USER_DIR: systemdDir,
    CLAUDE_OPS_BIN_DIR: binDir,
    CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
  };
  return { dir, claudeDir, systemdDir, binDir, env };
}

test('repair --apply wires statusLine, real CLI launcher, and current unit files', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node /old/src/hud/renderer.js' },
  }));

  const result = repair({ apply: true, env: s.env });

  assert.equal(result.ok, true);
  const settings = JSON.parse(readFileSync(join(s.claudeDir, 'settings.json'), 'utf8'));
  assert.equal(settings.statusLine.command, `node ${CLI_ENTRY}`);
  const launcherPath = join(s.binDir, 'claude-ops');
  assert.equal(lstatSync(launcherPath).isSymbolicLink(), false);
  assert.match(readFileSync(launcherPath, 'utf8'), /claude-ops launcher \(owned by claude-ops\)/);
  assert.match(readFileSync(launcherPath, 'utf8'), new RegExp(CLI_ENTRY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(readFileSync(join(s.systemdDir, 'claude-ops-analytics.service'), 'utf8'), /src\/analytics\/daemon\.js/);
  assert.match(readFileSync(join(s.systemdDir, 'claude-ops-guard.service'), 'utf8'), /src\/guard\/claude-ops-guard\.sh/);
  assert.equal(existsSync(join(s.claudeDir, 'plugins', 'claude-ops', 'guard-config', 'thinking.skip')), true);
  assert.equal(result.after.statusLineOk, true);
  assert.equal(result.after.legacyUnitsOk, true);
});

test('repair removes old unit files and stale setpoint ExecStart paths', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  writeFileSync(
    join(s.systemdDir, 'claude-hud-analytics.service'),
    'ExecStart=/usr/bin/node /home/core/dev/production/setpoint/src/analytics/daemon.js\n',
  );
  writeFileSync(
    join(s.systemdDir, 'claude-quality-guard.service'),
    'ExecStart=/home/core/dev/production/setpoint/src/guard/rust/target/release/setpoint-guard watch\n',
  );

  const result = repair({ apply: true, env: s.env });

  assert.equal(result.ok, true);
  assert.equal(existsSync(join(s.systemdDir, 'claude-hud-analytics.service')), false);
  assert.equal(existsSync(join(s.systemdDir, 'claude-quality-guard.service')), false);
  assert.equal(result.after.legacyUnitsOk, true);
});

test('repair preserves an already current Rust guard unit', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  writeFileSync(
    join(s.systemdDir, 'claude-ops-guard.service'),
    `[Unit]\nDescription=Claude Quality Guard (rust)\n[Service]\nExecStart=${RUST_GUARD_ENTRY} watch\n`,
  );

  const result = repair({ apply: true, env: s.env });

  assert.equal(result.ok, true);
  assert.match(readFileSync(join(s.systemdDir, 'claude-ops-guard.service'), 'utf8'), /target\/release\/claude-ops-guard watch/);
  assert.equal(result.after.coreServicesOk, true);
});

test('repair migrates legacy plugin state without overwriting current files', () => {
  const s = sandbox();
  const oldDir = join(s.claudeDir, 'plugins', 'claude-hud');
  const newDir = join(s.claudeDir, 'plugins', 'claude-ops');
  mkdirSync(oldDir, { recursive: true });
  mkdirSync(newDir, { recursive: true });
  writeFileSync(join(oldDir, 'usage-history.jsonl'), '{"old":true}\n');
  writeFileSync(join(newDir, 'usage-history.jsonl'), '{"new":true}\n');
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const result = repair({ apply: true, env: s.env });

  assert.equal(result.ok, true);
  assert.equal(readFileSync(join(newDir, 'usage-history.jsonl'), 'utf8'), '{"new":true}\n');
  const migratedBackup = result.operations.find(o => o.name === 'plugin-state-migration').detail;
  assert.match(migratedBackup, /copied legacy backup/);
});

test('repair reports conflict when claude-ops bin path is not an owned launcher', () => {
  const s = sandbox();
  writeFileSync(join(s.binDir, 'claude-ops'), '#!/bin/sh\n');
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const result = repair({ apply: true, env: s.env });

  assert.equal(result.ok, false);
  assert.equal(result.operations.find(o => o.name === 'cli-launcher').status, 'conflict');
});
