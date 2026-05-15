#!/usr/bin/env node
/**
 * `claude-ops repair` — idempotent local wiring repair.
 *
 * Dry-run by default. `--apply` mutates local Claude Ops wiring only:
 * statusLine, core systemd user units, and a local CLI launcher. It does
 * not write credentials and does not enable the quality guard.
 */

import {
  copyFileSync,
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import {
  CLI_ENTRY,
  CORE_UNITS,
  LEGACY_UNITS,
  REPO_ROOT,
  buildDoctorReport,
  getBinDir,
  getSystemdUserDir,
  servicePathCurrent,
} from './doctor.js';
import { getClaudeConfigDir } from '../data/paths.js';

export async function main(args = process.argv.slice(2), options = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const env = options.env ?? process.env;
  const result = repair({ apply, env });

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderRepairResult(result));
  }

  return result.ok ? 0 : 1;
}

export function repair({ apply = false, env = process.env } = {}) {
  const operations = [
    migratePluginState({ apply }),
    ensureGuardAuditConfig({ apply }),
    repairStatusLine({ apply }),
    repairCliLauncher({ apply, env }),
    repairCoreUnits({ apply, env }),
    cleanupLegacyUnits({ apply, env }),
  ];

  if (apply && operations.some(op => op.changed) && env.CLAUDE_OPS_SKIP_SYSTEMCTL !== '1') {
    const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8', env });
    operations.push({
      name: 'systemd-daemon-reload',
      status: reload.status === 0 ? 'changed' : 'failed',
      changed: reload.status === 0,
      detail: (reload.stderr || reload.stdout || '').trim(),
    });
  }

  const after = buildDoctorReport({ env });
  return {
    ok: operations.every(op => op.status !== 'failed' && op.status !== 'conflict'),
    applied: apply,
    repoRoot: REPO_ROOT,
    operations,
    after: summarizeAfter(after),
  };
}

function ensureGuardAuditConfig({ apply }) {
  const dir = join(getClaudeConfigDir(), 'plugins', 'claude-ops', 'guard-config');
  const skip = join(dir, 'thinking.skip');
  const reason = join(dir, 'thinking.skip.reason');
  const needsSkip = !existsSync(skip);
  const needsReason = !existsSync(reason) || !safeRead(reason).trim();
  if (!needsSkip && !needsReason) {
    return { name: 'guard-audit-config', status: 'ok', changed: false, detail: 'thinking skip present' };
  }
  if (!apply) {
    return { name: 'guard-audit-config', status: 'would-change', changed: false, detail: 'restore thinking skip marker/reason' };
  }
  mkdirSync(dir, { recursive: true });
  if (needsSkip) writeFileSync(skip, '');
  if (needsReason) writeFileSync(reason, 'opus_4_7_incompatible\n');
  return { name: 'guard-audit-config', status: 'changed', changed: true, detail: 'restored thinking skip marker/reason' };
}

function repairStatusLine({ apply }) {
  const settingsPath = join(getClaudeConfigDir(), 'settings.json');
  const expected = `node ${CLI_ENTRY}`;
  const settings = readJson(settingsPath) ?? {};
  const current = settings?.statusLine?.command ?? null;
  if (current === expected) {
    return { name: 'statusLine', status: 'ok', changed: false, detail: expected };
  }

  if (!apply) {
    return { name: 'statusLine', status: 'would-change', changed: false, detail: expected };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  backupIfExists(settingsPath);
  settings.statusLine = {
    ...(settings.statusLine ?? {}),
    type: 'command',
    command: expected,
    padding: settings.statusLine?.padding ?? 0,
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { name: 'statusLine', status: 'changed', changed: true, detail: expected };
}

function repairCliLauncher({ apply, env }) {
  const binDir = getBinDir(env);
  const binPath = join(binDir, 'claude-ops');
  const desired = launcherScript(CLI_ENTRY);

  if (existsSync(binPath)) {
    try {
      const stat = lstatSync(binPath);
      if (stat.isSymbolicLink()) {
        const target = readlinkTarget(binPath);
        if (!isOwnedCliTarget(target)) {
          return { name: 'cli-launcher', status: 'conflict', changed: false, detail: `${binPath} is a symlink to non-Claude-Ops target ${target}` };
        }
        if (!apply) return { name: 'cli-launcher', status: 'would-change', changed: false, detail: `replace symlink with real launcher at ${binPath}` };
        unlinkSync(binPath);
      } else {
        const current = safeRead(binPath);
        if (current === desired) {
          return { name: 'cli-launcher', status: 'ok', changed: false, detail: `${binPath} -> node ${CLI_ENTRY}` };
        }
        if (!isOwnedLauncher(current)) {
          return { name: 'cli-launcher', status: 'conflict', changed: false, detail: `${binPath} exists and is not a Claude Ops launcher` };
        }
        if (!apply) return { name: 'cli-launcher', status: 'would-change', changed: false, detail: `refresh launcher at ${binPath}` };
      }
    } catch {
      return { name: 'cli-launcher', status: 'failed', changed: false, detail: `cannot inspect ${binPath}` };
    }
  }

  if (!apply) {
    return { name: 'cli-launcher', status: 'would-change', changed: false, detail: `write launcher ${binPath} -> node ${CLI_ENTRY}` };
  }

  mkdirSync(binDir, { recursive: true });
  writeFileSync(binPath, desired);
  chmodSync(binPath, 0o755);
  return { name: 'cli-launcher', status: 'changed', changed: true, detail: `${binPath} -> node ${CLI_ENTRY}` };
}

function repairCoreUnits({ apply, env }) {
  const dir = getSystemdUserDir(env);
  const details = [];
  let changed = false;

  for (const unit of CORE_UNITS) {
    const target = join(dir, unit.name);
    const desired = renderUnit(unit);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    if (current === desired || (unit.expectedAny && servicePathCurrent(unit, current))) {
      details.push(`${unit.name}: ok`);
      continue;
    }
    details.push(`${unit.name}: ${apply ? 'changed' : 'would-change'}`);
    if (apply) {
      mkdirSync(dirname(target), { recursive: true });
      backupIfExists(target);
      writeFileSync(target, desired);
      changed = true;
    }
  }

  return {
    name: 'core-systemd-units',
    status: changed ? 'changed' : details.some(d => d.includes('would-change')) ? 'would-change' : 'ok',
    changed,
    detail: details.join('; '),
  };
}

function cleanupLegacyUnits({ apply, env }) {
  const dir = getSystemdUserDir(env);
  const details = [];
  let changed = false;
  let failed = false;

  for (const name of LEGACY_UNITS) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    details.push(`${name}: ${apply ? 'removed' : 'would-remove'}`);
    if (!apply) continue;

    if (env.CLAUDE_OPS_SKIP_SYSTEMCTL !== '1') {
      spawnSync('systemctl', ['--user', 'stop', name], { encoding: 'utf8', env });
      spawnSync('systemctl', ['--user', 'disable', name], { encoding: 'utf8', env });
    }

    try {
      backupIfExists(path);
      unlinkSync(path);
      changed = true;
    } catch (err) {
      failed = true;
      details.push(`${name}: failed ${err.message}`);
    }
  }

  return {
    name: 'legacy-systemd-units',
    status: failed ? 'failed' : changed ? 'changed' : details.length ? 'would-change' : 'ok',
    changed,
    detail: details.join('; ') || 'no old unit files',
  };
}

function migratePluginState({ apply }) {
  const claudeDir = getClaudeConfigDir();
  const pluginsDir = join(claudeDir, 'plugins');
  const dest = join(pluginsDir, 'claude-ops');
  const legacyDirs = ['claude-hud', 'setpoint'].map(name => join(pluginsDir, name));
  const existing = legacyDirs.filter(p => existsSync(p));
  if (existing.length === 0) {
    return { name: 'plugin-state-migration', status: 'ok', changed: false, detail: 'no legacy plugin state' };
  }
  if (!apply) {
    return {
      name: 'plugin-state-migration',
      status: 'would-change',
      changed: false,
      detail: existing.map(p => `${p} -> ${dest}`).join('; '),
    };
  }

  mkdirSync(dest, { recursive: true });
  const copied = [];
  for (const src of existing) {
    for (const name of safeListDir(src)) {
      const from = join(src, name);
      const to = join(dest, name);
      try {
        if (existsSync(to)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backup = join(dest, `${name}.legacy.${stamp}`);
          cpSync(from, backup, { recursive: true, force: false });
          copied.push(`${name}: kept current, copied legacy backup`);
        } else {
          cpSync(from, to, { recursive: true, force: false });
          copied.push(`${name}: copied`);
        }
      } catch (err) {
        return { name: 'plugin-state-migration', status: 'failed', changed: false, detail: `${from}: ${err.message}` };
      }
    }
  }
  return {
    name: 'plugin-state-migration',
    status: copied.length ? 'changed' : 'ok',
    changed: copied.length > 0,
    detail: copied.join('; ') || 'legacy dirs empty',
  };
}

function renderUnit(unit) {
  const content = readFileSync(unit.template, 'utf8');
  return content.replaceAll('{{INSTALL_DIR}}', REPO_ROOT);
}

function summarizeAfter(report) {
  return {
    ok: report.ok,
    runtimeMode: report.runtimeMode,
    cliOk: report.cli.ok,
    statusLineOk: report.statusLine.ok,
    coreServicesOk: report.services.every(s => s.ok),
    legacyUnitsOk: report.legacyUnits.every(s => !s.installed),
    guardAuditOnly: report.guard.auditOnly,
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function backupIfExists(path) {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, `${path}.bak.${stamp}`);
}

function safeListDir(path) {
  try { return readdirSync(path); }
  catch { return []; }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function readlinkTarget(path) {
  try {
    const raw = readlinkSync(path);
    return raw.startsWith('/') ? raw : resolve(dirname(path), raw);
  } catch {
    return null;
  }
}

function launcherScript(entry) {
  return `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY=${shQuote(entry)}
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`;
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isOwnedLauncher(content) {
  return typeof content === 'string' && content.includes('claude-ops launcher (owned by claude-ops)');
}

function isOwnedCliTarget(target) {
  return typeof target === 'string' && target.endsWith('/src/cli/index.js');
}

function renderRepairResult(result) {
  const lines = [];
  lines.push(`claude-ops repair: ${result.applied ? 'applied' : 'dry-run'}`);
  for (const op of result.operations) {
    lines.push(`${op.status.padEnd(12)} ${op.name}: ${op.detail}`);
  }
  lines.push('');
  lines.push('guard: repair preserves the current guard mode; use `claude-ops guard mode ...` to change enforcement');
  return `${lines.join('\n')}\n`;
}

function printHelp() {
  process.stdout.write(`\
claude-ops repair [--apply] [--json]

Dry-run by default. With --apply, repairs statusLine, core user systemd units,
and a real ~/.local/bin/claude-ops launcher file. It does not alter credentials
or enable the quality guard.

Test overrides:
  CLAUDE_CONFIG_DIR=/tmp/claude
  CLAUDE_OPS_SYSTEMD_USER_DIR=/tmp/systemd-user
  CLAUDE_OPS_BIN_DIR=/tmp/bin
  CLAUDE_OPS_SKIP_SYSTEMCTL=1
`);
}

if (process.argv[1] && process.argv[1].endsWith('/repair.js')) {
  main().then(code => process.exit(code ?? 0));
}
