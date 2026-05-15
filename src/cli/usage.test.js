import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageReport, renderUsageReport } from './usage.js';

const now = Date.parse('2026-05-03T12:00:00.000Z');

function row(minutesAgo, fields) {
  return {
    ts: new Date(now - minutesAgo * 60_000).toISOString(),
    ...fields,
  };
}

test('usage summarizes latest row per session to avoid over-counting cumulative costs', () => {
  const report = buildUsageReport([
    row(90, { session_id: 'a', session_cost_usd: 1, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered' }),
    row(60, { session_id: 'a', session_cost_usd: 2, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered', input_tokens: 100 }),
    row(45, { session_id: 'b', session_cost_usd: 3, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered', cache_read_tokens: 200 }),
  ], { now, since: now - 24 * 3600_000, until: now });

  assert.equal(report.counts.sessions, 2);
  assert.equal(report.totals.estimatedApiBillableUsd, 5);
  assert.equal(report.totals.inputTokens, 100);
  assert.equal(report.totals.cacheReadTokens, 200);
});

test('usage filters by session and keeps estimate labels explicit', () => {
  const report = buildUsageReport([
    row(60, { session_id: 'a', session_cost_usd: 2, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered' }),
    row(45, { session_id: 'b', session_cost_usd: 3, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered' }),
  ], { now, since: now - 24 * 3600_000, until: now, sessionId: 'b' });

  assert.equal(report.counts.sessions, 1);
  assert.equal(report.sessions[0].sessionId, 'b');
  assert.equal(report.totals.estimatedApiBillableUsd, 3);
  assert.match(renderUsageReport(report), /actual\/estimated/);
});

test('usage counts statusLine actual costs as API spend', () => {
  const report = buildUsageReport([
    row(60, { session_id: 'actual', session_cost_usd: 4, cost_kind: 'api_statusline_actual', billing_signal: 'cost-metered' }),
    row(45, { session_id: 'estimate', session_cost_usd: 3, cost_kind: 'api_billable_estimate', billing_signal: 'cost-metered' }),
  ], { now, since: now - 24 * 3600_000, until: now });

  assert.equal(report.counts.costMeteredSessions, 2);
  assert.equal(report.totals.apiSpendUsd, 7);
  assert.equal(report.sessions.find(s => s.sessionId === 'actual').apiSpendUsd, 4);
  assert.equal(report.sessions.find(s => s.sessionId === 'actual').costKind, 'api_statusline_actual');
});

test('usage summarizes Vertex telemetry authority and quota events', () => {
  const report = buildUsageReport([
    row(30, {
      session_id: 'v1',
      billing_signal: 'cost-metered',
      auth_provider: 'vertex',
      backend: 'vertex-ai',
      vertex_5h_tokens: 1500,
      vertex_7d_tokens: 3000,
      quota_event_reason: 'GCP_QUOTA_EXHAUSTED',
    }),
  ], { now, since: now - 24 * 3600_000, until: now });

  assert.equal(report.backends['vertex-ai'], 1);
  assert.equal(report.vertex.sessions, 1);
  assert.equal(report.vertex.fiveHourTokens, 1500);
  assert.equal(report.vertex.quotaEvents, 1);
  assert.equal(report.vertex.authorities['unknown'], 1);
  assert.match(renderUsageReport(report), /vertex telemetry/);
});
