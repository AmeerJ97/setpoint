import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildDoctorReport, CLI_ENTRY, RUST_GUARD_ENTRY, inspectCli, inspectServices, inspectStatusLine } from './doctor.js';

const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_SYSTEMD_DIR = process.env.CLAUDE_OPS_SYSTEMD_USER_DIR;
const ORIGINAL_BIN_DIR = process.env.CLAUDE_OPS_BIN_DIR;
const SANDBOXES = [];

afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  if (ORIGINAL_SYSTEMD_DIR === undefined) delete process.env.CLAUDE_OPS_SYSTEMD_USER_DIR;
  else process.env.CLAUDE_OPS_SYSTEMD_USER_DIR = ORIGINAL_SYSTEMD_DIR;
  if (ORIGINAL_BIN_DIR === undefined) delete process.env.CLAUDE_OPS_BIN_DIR;
  else process.env.CLAUDE_OPS_BIN_DIR = ORIGINAL_BIN_DIR;
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-doctor-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  const systemdDir = join(dir, 'systemd-user');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(systemdDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  return { dir, claudeDir, systemdDir };
}

test('doctor reports subscription quota mode from statusLine stdin', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `node ${CLI_ENTRY}` },
  }));

  const report = buildDoctorReport({
    stdinPayload: {
      session_id: 'sid',
      model: { id: 'claude-opus-4-7' },
      rate_limits: { five_hour: {}, seven_day: {} },
    },
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  assert.equal(report.runtimeMode.authProvider, 'subscription');
  assert.equal(report.runtimeMode.billingSignal, 'quota-window');
  assert.equal(report.statusLine.ok, true);
});

test('doctor reports cost-metered API mode without leaking credential values', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/bin/echo key' }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-5' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      ANTHROPIC_AUTH_TOKEN: 'bearer-secret',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
    },
  });

  const json = JSON.stringify(report);
  assert.equal(report.runtimeMode.authProvider, 'gateway');
  assert.equal(report.runtimeMode.billingSignal, 'cost-metered');
  assert.equal(report.authSignals.ANTHROPIC_API_KEY, true);
  assert.equal(report.authSignals.ANTHROPIC_AUTH_TOKEN, true);
  assert.equal(report.authSignals.ANTHROPIC_BASE_URL, true);
  assert.equal(report.authSignals.apiKeyHelper, true);
  assert.doesNotMatch(json, /sk-ant-secret|bearer-secret|gateway\.example/);
});

test('doctor reports legacy unit drift separately from current services', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `node ${CLI_ENTRY}` },
  }));
  writeFileSync(
    join(s.systemdDir, 'claude-hud-analytics.service'),
    'ExecStart=/usr/bin/node /home/core/dev/production/setpoint/src/analytics/daemon.js\n',
  );

  const report = buildDoctorReport({
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  const legacy = report.legacyUnits.find(u => u.name === 'claude-hud-analytics.service');
  assert.equal(legacy.installed, true);
  assert.equal(legacy.stalePath, true);
  assert.equal(report.checks.find(c => c.name === 'legacy-units').status, 'fix');
  assert.ok(report.fixPlan.some(a => a.id === 'remove-legacy-units'));
});

test('doctor exposes the discovered managed install target', () => {
  const s = sandbox();
  const installRoot = join(s.dir, 'installed-root');
  const binDir = join(s.dir, 'bin');
  mkdirSync(join(installRoot, 'src', 'cli'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(installRoot, 'package.json'), '{}\n');
  writeFileSync(join(installRoot, 'src', 'cli', 'index.js'), '#!/usr/bin/env node\n');
  writeFileSync(join(binDir, 'claude-ops'), `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='${join(installRoot, 'src', 'cli', 'index.js')}'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`);
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const report = buildDoctorReport({
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_BIN_DIR: binDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
    },
  });

  assert.equal(report.installTarget.root, installRoot);
  assert.equal(report.installTarget.source, 'owned-launcher');
});

test('doctor includes local-estimate provider adapter metadata for API mode', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid' },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
    },
  });

  assert.equal(report.providerAdapter.id, 'api-key');
  assert.equal(report.providerAdapter.billingSource, 'statusline-cost-or-local-estimate');
  assert.equal(report.providerAdapter.credentialedBilling, false);
});

test('doctor advertises guard repair as a separate fix lane for docs-backed drift', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `node ${CLI_ENTRY}` },
  }));

  const report = buildDoctorReport({
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  assert.equal(report.checks.find(c => c.name === 'guard-controls')?.status, 'fix');
  assert.ok(report.fixPlan.some(a => a.id === 'repair-guard-controls'));
});

test('doctor reports disabled guard mode distinctly from audit-only', () => {
  const s = sandbox();
  const disabledFlag = join(s.claudeDir, 'plugins', 'claude-ops', 'guard-disabled');
  mkdirSync(join(s.claudeDir, 'plugins', 'claude-ops'), { recursive: true });
  writeFileSync(disabledFlag, '');
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `node ${CLI_ENTRY}` },
  }));

  const report = buildDoctorReport({
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  assert.equal(report.guard.mode, 'disabled');
  assert.equal(report.guard.auditOnly, false);
});

test('doctor reports Vertex backend and audit-only config inventory', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
    },
  });

  assert.equal(report.runtimeMode.backend, 'vertex-ai');
  assert.equal(report.runtimeMode.telemetryAuthority, 'local-synthetic');
  assert.equal(report.runtimeMode.backendLabel, '[VERTEX-AI]');
  assert.equal(report.vertexConfig.active, true);
  assert.equal(report.vertexConfig.state, 'held');
  assert.equal(report.vertexConfig.auditOnly, true);
});

test('doctor reports experimental gates as gated by default', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));

  const report = buildDoctorReport({
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  assert.equal(report.experimentalTools.scan.enabled, false);
  assert.equal(report.experimentalTools.consolidate.enabled, false);
});

test('doctor accepts freshly installed Rust guard unit as current', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: `node ${CLI_ENTRY}` },
  }));
  writeFileSync(
    join(s.systemdDir, 'claude-ops-guard.service'),
    `[Service]\nExecStart=${RUST_GUARD_ENTRY} watch\n`,
  );

  const report = buildDoctorReport({
    env: { CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir, CLAUDE_OPS_SKIP_SYSTEMCTL: '1' },
  });

  const guardUnit = report.services.find(svc => svc.name === 'claude-ops-guard.service');
  assert.equal(guardUnit.installed, true);
  assert.equal(guardUnit.pathCurrent, true);
});

test('doctor distinguishes a healthy installed copy from stale source-checkout drift', () => {
  const s = sandbox();
  const binDir = join(s.dir, 'bin');
  const installRoot = join(s.dir, 'share', 'claude-ops');
  const installedEntry = join(installRoot, 'src', 'cli', 'index.js');
  const installedGuard = join(installRoot, 'src', 'guard', 'rust', 'target', 'release', 'claude-ops-guard');
  mkdirSync(dirnameOf(installedEntry), { recursive: true });
  mkdirSync(dirnameOf(installedGuard), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(installedEntry, '#!/usr/bin/env node\n');
  writeFileSync(installedGuard, '');
  writeFileSync(join(binDir, 'claude-ops'), `#!/bin/sh
# claude-ops launcher (owned by claude-ops)
CLAUDE_OPS_ENTRY='${installedEntry}'
exec /usr/bin/env node "$CLAUDE_OPS_ENTRY" "$@"
`, { mode: 0o755 });
  writeFileSync(
    join(s.systemdDir, 'claude-ops-guard.service'),
    `[Service]\nExecStart=${installedGuard} watch\n`,
  );

  const cli = inspectCli({ CLAUDE_OPS_BIN_DIR: binDir, PATH: process.env.PATH });
  const statusLine = inspectStatusLine({ statusLine: { command: `node ${installedEntry}` } });
  const services = inspectServices({ CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir });

  assert.equal(cli.ok, true);
  assert.equal(cli.installedElsewhere, true);
  assert.equal(statusLine.ok, true);
  assert.equal(statusLine.installedElsewhere, true);
  assert.equal(services.find(svc => svc.name === 'claude-ops-guard.service').ok, true);
});

function dirnameOf(path) {
  return path.slice(0, path.lastIndexOf('/'));
}


test('doctor flags stale Vertex API snapshot as non-authoritative', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const staleSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(staleSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
    five_hour: { total_tokens: 1000, cost_usd: 6.5 },
    seven_day: { total_tokens: 8000, cost_usd: 45.0 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: staleSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.backend, 'vertex-ai');
  assert.equal(report.runtimeMode.telemetryAuthority, 'local-synthetic');
  assert.equal(report.vertexTelemetry?.missingApiTelemetry, true);
  assert.match(report.vertexTelemetry?.apiTelemetryReason ?? '', /stale/);
  const c = report.checks.find(x => x.name === 'vertex-api-telemetry');
  assert.equal(c?.status, 'fix');
});



test('doctor flags disabled Vertex staleness cutoff override as risky', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const staleSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(staleSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
    five_hour: { total_tokens: 1000, cost_usd: 6.5 },
    seven_day: { total_tokens: 8000, cost_usd: 45.0 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: staleSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '0',
    },
  });

  const c = report.checks.find(x => x.name === 'vertex-api-staleness-policy');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /staleness cutoff disabled/i);
});

test('doctor accepts positive Vertex staleness cutoff override', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const freshSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(freshSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 1200, cost_usd: 7.2 },
    seven_day: { total_tokens: 9600, cost_usd: 57.8 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: freshSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '45',
    },
  });

  const c = report.checks.find(x => x.name === 'vertex-api-staleness-policy');
  assert.equal(c?.status, 'ok');
  assert.match(c?.detail ?? '', /staleness cutoff 45m/i);
});

test('doctor flags non-authoritative Vertex telemetry when API-required bypass is enabled', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const staleSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(staleSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
    five_hour: { total_tokens: 1000, cost_usd: 6.5 },
    seven_day: { total_tokens: 8000, cost_usd: 45.0 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: staleSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
      CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY: '0',
    },
  });

  assert.equal(report.runtimeMode.backend, 'vertex-ai');
  assert.equal(report.runtimeMode.telemetryAuthority, 'local-synthetic');
  assert.equal(report.vertexTelemetry?.missingApiTelemetry, false);
  const c = report.checks.find(x => x.name === 'vertex-api-telemetry');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /telemetry authority local-synthetic/i);
  const vc = report.checks.find(x => x.name === 'vertex-config');
  assert.equal(vc?.status, 'fix');
  assert.match(vc?.detail ?? '', /API telemetry bypass enabled/i);
});


test('doctor flags authoritative Vertex snapshots with nonzero tokens but zero cost as inconsistent', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const apiSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(apiSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 1200, input_tokens: 800, output_tokens: 400, cost_usd: 0 },
    seven_day: { total_tokens: 9000, input_tokens: 6000, output_tokens: 3000, cost_usd: 0 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: apiSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.telemetryAuthority, 'vertex-api');
  const c = report.checks.find(x => x.name === 'vertex-api-cost-consistency');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /nonpositive or negative cost_usd/i);
});

test('doctor flags authoritative Vertex snapshots with negative cost as inconsistent', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const apiSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(apiSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 1200, cost_usd: -1.23 },
    seven_day: { total_tokens: 9000, cost_usd: -8.76 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: apiSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.telemetryAuthority, 'vertex-api');
  const c = report.checks.find(x => x.name === 'vertex-api-cost-consistency');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /nonpositive.*cost_usd/i);
});

test('doctor flags authoritative Vertex snapshots with negative cost even when tokens are zero', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const apiSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(apiSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 0, cost_usd: -0.1 },
    seven_day: { total_tokens: 0, cost_usd: -0.2 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: apiSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.telemetryAuthority, 'vertex-api');
  const c = report.checks.find(x => x.name === 'vertex-api-cost-consistency');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /nonpositive.*cost_usd/i);
});

test('doctor flags authoritative Vertex snapshots with zero usage as non-actionable telemetry', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const apiSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(apiSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 0, cost_usd: 0 },
    seven_day: { total_tokens: 0, cost_usd: 1.25 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: apiSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.telemetryAuthority, 'vertex-api');
  const c = report.checks.find(x => x.name === 'vertex-api-cost-consistency');
  assert.equal(c?.status, 'fix');
  assert.match(c?.detail ?? '', /zero total_tokens/i);
});

test('doctor accepts authoritative Vertex snapshots when cost fields are present', () => {
  const s = sandbox();
  writeFileSync(join(s.claudeDir, 'settings.json'), JSON.stringify({}));
  const apiSnapshot = join(s.dir, 'vertex-api-telemetry.json');
  writeFileSync(apiSnapshot, JSON.stringify({
    retrieved_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    five_hour: { total_tokens: 1200, cost_usd: 1.23 },
    seven_day: { total_tokens: 9000, cost_usd: 8.76 },
  }));

  const report = buildDoctorReport({
    stdinPayload: { session_id: 'sid', model: { id: 'claude-sonnet-4-6' } },
    env: {
      CLAUDE_OPS_SYSTEMD_USER_DIR: s.systemdDir,
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
      CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE: apiSnapshot,
      CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES: '20',
    },
  });

  assert.equal(report.runtimeMode.telemetryAuthority, 'vertex-api');
  const c = report.checks.find(x => x.name === 'vertex-api-cost-consistency');
  assert.equal(c?.status, 'ok');
  assert.match(c?.detail ?? '', /cost fields present/i);
});
