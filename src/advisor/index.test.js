import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-daily-advisor-'));
process.env.CLAUDE_CONFIG_DIR = join(sandbox, '.claude');
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const paths = await import('../data/paths.js');

test('daily advisor treats fixture-only history as no trusted data', () => {
  mkdirSync(paths.PLUGIN_DIR, { recursive: true });
  const now = new Date().toISOString();
  const rows = [
    {
      schema_version: 3,
      ts: now,
      session_id: 'fixture-subscription',
      mode: 'max',
      billing_signal: 'quota-window',
      auth_provider: 'subscription',
      backend: 'anthropic-pro',
      telemetry_authority: 'server-rate-limits',
      five_hour_pct: 92,
      seven_day_pct: 88,
      session_burn_rate: 999,
      model: 'Claude Opus 4.7',
      project_path: '/tmp/claude-ops-fixture',
    },
  ];
  writeFileSync(paths.HISTORY_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  execFileSync('node', ['src/cli/index.js', 'advisor'], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_USE_VERTEX: '1' },
    stdio: 'pipe',
  });

  const report = readFileSync(paths.DAILY_REPORT_FILE, 'utf8');
  assert.match(report, /\*\*Tier:\*\* no_data/);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
