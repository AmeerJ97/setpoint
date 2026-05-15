import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-advisor-status-'));
process.env.CLAUDE_CONFIG_DIR = join(sandbox, '.claude');
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const paths = await import('../data/paths.js');
const mod = await import('./advisor-status.js');

test('advisor status reconstructs Vertex history without fake subscription quota', () => {
  mkdirSync(paths.PLUGIN_DIR, { recursive: true });
  const now = Date.now();
  const rows = [
    {
      ts: new Date(now - 20 * 60_000).toISOString(),
      session_id: 'v1',
      mode: 'api',
      billing_signal: 'cost-metered',
      auth_provider: 'vertex',
      backend: 'vertex-ai',
      telemetry_authority: 'local-synthetic',
      session_burn_rate: 120,
      input_tokens: 1000,
      output_tokens: 500,
      cache_create_tokens: 250,
      cache_read_tokens: 100,
      model: 'claude-sonnet-4-6',
      quota_event_reason: 'GCP_QUOTA_EXHAUSTED',
      quota_event_code: 'RESOURCE_EXHAUSTED',
      quota_event_ts: new Date(now - 10 * 60_000).toISOString(),
    },
  ];
  writeFileSync(paths.HISTORY_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const state = mod.collectAdvisorState();
  assert.equal(state.runtimeMode.backend, 'vertex-ai');
  assert.equal(state.runtimeMode.telemetryAuthority, 'local-synthetic');
  assert.equal(state.backendBadge, '[VERTEX-AI]');
  assert.equal(state.recommendation.tier, 'vertex_quota_exhausted');
  assert.equal(state.vertexSource.authoritative, false);
  assert.equal(state.vertexSource.authority, 'local-synthetic');
  assert.match(state.vertexSource.reason ?? '', /authoritative Vertex API snapshot/);
  assert.equal(state.recommendation.signal, 'limit_hit');
  assert.equal(state.recommendation.fiveHour, null);
  assert.equal(state.vertexTelemetry.latestQuotaEvent.causalReason, 'GCP_QUOTA_EXHAUSTED');
});

test('advisor status uses authoritative Vertex API telemetry and mature turn signals for confidence', () => {
  mkdirSync(paths.PLUGIN_DIR, { recursive: true });
  const now = Date.now();
  const rows = [
    {
      ts: new Date(now - 5 * 60_000).toISOString(),
      session_id: 'v-api-1',
      mode: 'api',
      billing_signal: 'cost-metered',
      auth_provider: 'vertex',
      backend: 'vertex-ai',
      telemetry_authority: 'local-synthetic',
      session_burn_rate: 120,
      duration_min: 95,
      api_calls: 30,
      input_tokens: 6000,
      output_tokens: 3000,
      cache_create_tokens: 1000,
      cache_read_tokens: 400,
      model: 'claude-sonnet-4-6',
    },
  ];
  writeFileSync(paths.HISTORY_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(paths.VERTEX_API_TELEMETRY_FILE, JSON.stringify({
    retrieved_at: new Date(now).toISOString(),
    five_hour: { total_tokens: 10400, cost_usd: 1.52 },
    seven_day: { total_tokens: 88200, cost_usd: 12.14 },
  }));

  const state = mod.collectAdvisorState();
  assert.equal(state.runtimeMode.backend, 'vertex-ai');
  assert.equal(state.runtimeMode.telemetryAuthority, 'vertex-api');
  assert.equal(state.vertexTelemetry.telemetryAuthority, 'vertex-api');
  assert.equal(state.vertexSource.authoritative, true);
  assert.equal(state.vertexSource.authority, 'vertex-api');
  assert.ok(typeof state.vertexSource.fingerprint === 'string' && state.vertexSource.fingerprint.length === 16);
  assert.equal(state.vertexSource.retrievedAt, new Date(now).toISOString());
  assert.equal(state.recommendation.confidence, 'high');
  assert.match(state.recommendation.confidenceWhy, /authoritative API telemetry active/);
});

test('advisor status ignores trailing fixture rows when reconstructing latest mode', () => {
  mkdirSync(paths.PLUGIN_DIR, { recursive: true });
  const now = Date.now();
  const rows = [
    {
      ts: new Date(now - 8 * 60_000).toISOString(),
      session_id: 'v-api-real',
      mode: 'api',
      billing_signal: 'cost-metered',
      auth_provider: 'vertex',
      backend: 'vertex-ai',
      telemetry_authority: 'local-synthetic',
      session_burn_rate: 140,
      duration_min: 100,
      api_calls: 20,
      input_tokens: 5000,
      output_tokens: 2000,
      cache_create_tokens: 200,
      cache_read_tokens: 200,
      model: 'claude-sonnet-4-6',
      project_path: '/home/core/dev/prod/claude-ops',
    },
    {
      ts: new Date(now - 2 * 60_000).toISOString(),
      session_id: 'fixture-subscription',
      mode: 'max',
      billing_signal: 'quota-window',
      auth_provider: 'subscription',
      backend: 'anthropic-pro',
      telemetry_authority: 'server-rate-limits',
      five_hour_pct: 90,
      seven_day_pct: 90,
      session_burn_rate: 999,
      model: 'Claude Opus 4.7',
      project_path: '/tmp/claude-ops-fixture',
    },
  ];
  writeFileSync(paths.HISTORY_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const state = mod.collectAdvisorState();
  assert.equal(state.runtimeMode.backend, 'vertex-ai');
  assert.equal(state.backendBadge, '[VERTEX-AI]');
  assert.equal(state.latestSample.session_id, 'v-api-real');
});

test('advisor status treats fixture-only history as no trusted data', () => {
  mkdirSync(paths.PLUGIN_DIR, { recursive: true });
  const now = Date.now();
  const rows = [
    {
      ts: new Date(now - 2 * 60_000).toISOString(),
      session_id: 'fixture-subscription',
      mode: 'max',
      billing_signal: 'quota-window',
      auth_provider: 'subscription',
      backend: 'anthropic-pro',
      telemetry_authority: 'server-rate-limits',
      five_hour_pct: 90,
      seven_day_pct: 90,
      session_burn_rate: 999,
      model: 'Claude Opus 4.7',
      project_path: '/tmp/claude-ops-fixture',
    },
  ];
  writeFileSync(paths.HISTORY_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const state = mod.collectAdvisorState();
  assert.equal(state.hasData, false);
  assert.equal(state.latestSample, null);
  assert.equal(state.recommendation.tier, 'no_data');
  assert.equal(state.vertexSource, null);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});
