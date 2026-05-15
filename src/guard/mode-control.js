import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClaudeConfigDir } from '../data/paths.js';

const UNIT = 'claude-ops-guard.service';

export function getSystemdUserDir(env = process.env) {
  return env.CLAUDE_OPS_SYSTEMD_USER_DIR || join(homedir(), '.config', 'systemd', 'user');
}

export function guardPaths(env = process.env) {
  const claudeDir = getClaudeConfigDir();
  const pluginDir = join(claudeDir, 'plugins', 'claude-ops');
  const configDir = join(pluginDir, 'guard-config');
  return {
    pluginDir,
    configDir,
    servicePath: join(getSystemdUserDir(env), UNIT),
    disabledFlag: join(pluginDir, 'guard-disabled'),
    thinkingSkip: join(configDir, 'thinking.skip'),
    thinkingSkipReason: join(configDir, 'thinking.skip.reason'),
  };
}

export function inspectGuardControl(env = process.env) {
  const paths = guardPaths(env);
  const installed = existsSync(paths.servicePath);
  const active = systemctlState('is-active', UNIT, env);
  const enabled = systemctlState('is-enabled', UNIT, env);
  const disabled = existsSync(paths.disabledFlag);
  const activeNow = active === 'active' && !disabled;
  const enabledForStartup = enabled === 'enabled' && !disabled;
  const mode = disabled ? 'disabled' : (activeNow || enabledForStartup ? 'enforce' : 'audit');
  return {
    installed,
    active,
    enabled,
    disabled,
    activeNow,
    enabledForStartup,
    mode,
    auditOnly: mode === 'audit',
    detail: describeGuardMode({ disabled, active, enabled, activeNow, enabledForStartup }),
    thinkingSkip: existsSync(paths.thinkingSkip),
    thinkingSkipReason: safeRead(paths.thinkingSkipReason).trim() || null,
  };
}

export function configureGuardMode(mode, env = process.env) {
  const normalized = normalizeMode(mode);
  if (!normalized) return { ok: false, mode, error: `unknown guard mode: ${mode}` };

  const paths = guardPaths(env);
  mkdirSync(paths.pluginDir, { recursive: true });
  mkdirSync(paths.configDir, { recursive: true });

  if (normalized === 'status') {
    return { ok: true, requestedMode: 'status', guard: inspectGuardControl(env) };
  }

  if (normalized === 'audit') {
    rmSync(paths.disabledFlag, { force: true });
    const control = stopAndDisable(env);
    return {
      ok: control.ok,
      requestedMode: 'audit',
      guard: inspectGuardControl(env),
      detail: control.detail || 'guard audit-only configured',
    };
  }

  if (normalized === 'disabled') {
    writeFileSync(paths.disabledFlag, '');
    const control = stopAndDisable(env);
    return {
      ok: control.ok,
      requestedMode: 'disabled',
      guard: inspectGuardControl(env),
      detail: control.detail || 'guard disabled',
    };
  }

  rmSync(paths.disabledFlag, { force: true });
  const control = enableAndStart(env);
  return {
    ok: control.ok,
    requestedMode: 'enforce',
    guard: inspectGuardControl(env),
    detail: control.detail || 'guard enforcement configured',
  };
}

function normalizeMode(mode) {
  const value = String(mode ?? 'status').trim().toLowerCase();
  if (['status', 'audit', 'enforce', 'disabled'].includes(value)) return value;
  return null;
}

function enableAndStart(env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') {
    return { ok: true, detail: 'guard enforcement requested; systemctl skipped' };
  }
  const enable = spawnSync('systemctl', ['--user', 'enable', UNIT], { encoding: 'utf8', env });
  const start = spawnSync('systemctl', ['--user', 'start', UNIT], { encoding: 'utf8', env });
  const state = inspectGuardControl(env);
  const ok = enable.status === 0 && start.status === 0 && state.activeNow;
  return {
    ok,
    detail: (start.stderr || start.stdout || enable.stderr || enable.stdout || '').trim() || 'guard enforcement configured',
  };
}

function stopAndDisable(env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') {
    return { ok: true, detail: 'guard mode updated; systemctl skipped' };
  }
  const result = spawnSync('systemctl', ['--user', 'disable', '--now', UNIT], { encoding: 'utf8', env });
  const state = inspectGuardControl(env);
  const ok = result.status === 0 && !state.activeNow && !state.enabledForStartup;
  return {
    ok,
    detail: (result.stderr || result.stdout || '').trim() || 'guard mode updated',
  };
}

function systemctlState(action, unit, env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') return 'skipped';
  const result = spawnSync('systemctl', ['--user', action, unit], { encoding: 'utf8', env });
  const text = (result.stdout || result.stderr || '').trim();
  return text || (result.status === 0 ? 'ok' : 'unknown');
}

function describeGuardMode({ disabled, active, enabled, activeNow, enabledForStartup }) {
  if (disabled) return 'guard disabled via flag';
  if (activeNow) return 'guard service active';
  if (enabledForStartup) return 'guard enabled at login but not currently active';
  if (active === 'active') return 'guard service active but disabled flag present';
  if (enabled === 'enabled') return 'guard enabled at login but disabled flag present';
  return 'guard enforcement disabled (audit-only)';
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}
