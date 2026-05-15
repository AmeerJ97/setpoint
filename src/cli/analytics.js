#!/usr/bin/env node
/**
 * `claude-ops analytics` — inspect/control the on-demand analytics collector.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CORE_UNITS, getSystemdUserDir } from './doctor.js';

const UNIT = 'claude-ops-analytics.service';

export async function main(args = process.argv.slice(2), options = {}) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const json = args.includes('--json');
  const filtered = args.filter(a => a !== '--json');
  const action = filtered[0] ?? 'status';
  const env = options.env ?? process.env;

  let result;
  if (action === 'status') {
    result = inspectAnalytics(env);
  } else if (['start', 'stop', 'restart'].includes(action)) {
    result = controlAnalytics(action, env);
  } else {
    result = { ok: false, action, error: `unknown analytics command: ${action}` };
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderAnalyticsResult(result));
  }

  return result.ok ? 0 : 1;
}

export function inspectAnalytics(env = process.env) {
  const unitPath = join(getSystemdUserDir(env), UNIT);
  const unitText = safeRead(unitPath);
  const active = systemctlState('is-active', UNIT, env);
  const enabled = systemctlState('is-enabled', UNIT, env);
  const show = systemctlShow(UNIT, env);
  const expected = CORE_UNITS.find(u => u.name === UNIT)?.expected ?? null;
  return {
    ok: existsSync(unitPath),
    unit: UNIT,
    unitPath,
    installed: existsSync(unitPath),
    pathCurrent: expected ? unitText.includes(expected) : false,
    active,
    enabled,
    pid: show.MainPID && show.MainPID !== '0' ? Number(show.MainPID) : null,
    memoryBytes: show.MemoryCurrent ? Number(show.MemoryCurrent) : null,
    cpuQuota: show.CPUQuotaPerSecUSec ?? null,
    environment: splitEnv(show.Environment),
    mode: 'on-demand',
    behavior: 'Claude Code statusLine starts this service; it exits after idle time.',
    controls: {
      start: 'claude-ops analytics start',
      stop: 'claude-ops analytics stop',
      disable: 'CLAUDE_OPS_DISABLE_ANALYTICS=1 disables HUD wakeups',
      keepAlive: 'CLAUDE_OPS_ANALYTICS_KEEPALIVE=1 preserves old always-on daemon behavior',
    },
  };
}

function controlAnalytics(action, env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') {
    return { ok: false, action, error: 'systemctl skipped by CLAUDE_OPS_SKIP_SYSTEMCTL=1' };
  }
  const args = action === 'restart'
    ? ['--user', 'restart', UNIT]
    : ['--user', action, UNIT];
  const r = spawnSync('systemctl', args, { encoding: 'utf8', env });
  return {
    ...inspectAnalytics(env),
    ok: r.status === 0,
    action,
    detail: (r.stderr || r.stdout || '').trim(),
  };
}

export function renderAnalyticsResult(result) {
  if (result.error) return `claude-ops analytics: ${result.error}\n`;
  const state = result.active === 'active' ? 'running' : 'stopped';
  const enabled = result.enabled === 'enabled' ? 'enabled at login' : 'not enabled at login';
  const lines = [
    `claude-ops analytics: ${state} (${result.mode}, ${enabled})`,
    `unit: ${result.installed ? result.unitPath : 'not installed'}`,
    `path: ${result.pathCurrent ? 'current' : 'missing/stale'}`,
    `behavior: ${result.behavior}`,
  ];
  if (result.pid) lines.push(`process: pid ${result.pid}${result.memoryBytes ? `, memory ${formatBytes(result.memoryBytes)}` : ''}`);
  if (result.cpuQuota) lines.push(`limit: CPUQuotaPerSecUSec=${result.cpuQuota}`);
  if (result.environment?.length) lines.push(`env: ${result.environment.join(' ')}`);
  lines.push('controls: claude-ops analytics start | stop | restart | status --json');
  lines.push('disable wakeups: CLAUDE_OPS_DISABLE_ANALYTICS=1');
  return `${lines.join('\n')}\n`;
}

function systemctlState(action, unit, env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') return 'skipped';
  const r = spawnSync('systemctl', ['--user', action, unit], { encoding: 'utf8', env });
  const text = (r.stdout || r.stderr || '').trim();
  return text || (r.status === 0 ? 'ok' : 'unknown');
}

function systemctlShow(unit, env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') return {};
  const r = spawnSync('systemctl', [
    '--user',
    'show',
    unit,
    '-p', 'MainPID',
    '-p', 'MemoryCurrent',
    '-p', 'CPUQuotaPerSecUSec',
    '-p', 'Environment',
    '--no-pager',
  ], { encoding: 'utf8', env });
  if (r.status !== 0) return {};
  return Object.fromEntries((r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const idx = line.indexOf('=');
      return idx === -1 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1)];
    }));
}

function splitEnv(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().split(/\s+/)
    : [];
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function printHelp() {
  process.stdout.write(`\
claude-ops analytics status [--json]
claude-ops analytics start|stop|restart [--json]

The analytics collector is on-demand. Claude Code statusLine renders wake the
systemd user service, and the daemon exits after idle time when no Claude Code
sessions are active.
`);
}

if (process.argv[1] && process.argv[1].endsWith('/analytics.js')) {
  main().then(code => process.exit(code ?? 0));
}
