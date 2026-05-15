import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeVertexTelemetry,
  computeVertexSyntheticTelemetry,
  extractVertexQuotaEventsFromText,
} from './vertex-telemetry.js';

const now = Date.parse('2026-05-03T12:00:00Z');

function row(minutesAgo, overrides = {}) {
  return {
    ts: new Date(now - minutesAgo * 60_000).toISOString(),
    session_id: overrides.session_id ?? `s-${minutesAgo}`,
    auth_provider: 'vertex',
    backend: 'vertex-ai',
    input_tokens: 100,
    output_tokens: 50,
    cache_create_tokens: 25,
    cache_read_tokens: 10,
    api_calls: 1,
    session_burn_rate: 42,
    ...overrides,
  };
}

test('Vertex synthetic telemetry aggregates latest rows per session in rolling windows', () => {
  const telemetry = computeVertexSyntheticTelemetry(
    { totalInput: 300, totalOutput: 100, totalCacheCreate: 40, totalCacheRead: 20, apiCalls: 2, burnRate: 80 },
    [
      row(20, { session_id: 'old', input_tokens: 10 }),
      row(10, { session_id: 'old', input_tokens: 200 }),
      row(400, { session_id: 'outside-5h', input_tokens: 500 }),
    ],
    { currentSessionId: 'current', now, quotaEventFile: '/does/not/exist.jsonl' },
  );

  assert.equal(telemetry.backend, 'vertex-ai');
  assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
  assert.equal(telemetry.synthetic, true);
  assert.equal(telemetry.fiveHour.sessions, 2);
  assert.equal(telemetry.fiveHour.inputTokens, 500);
  assert.equal(telemetry.fiveHour.totalTokens, 745);
  assert.equal(telemetry.sevenDay.sessions, 3);
});

test('Vertex synthetic telemetry reports cold start and low confidence with no history', () => {
  const telemetry = computeVertexSyntheticTelemetry(null, [], { now, quotaEventFile: '/does/not/exist.jsonl' });
  assert.equal(telemetry.dataMaturity.state, 'cold_start');
  assert.equal(telemetry.confidenceCap, 'low');
  assert.equal(telemetry.signal, null);
});

test('Vertex RESOURCE_EXHAUSTED evidence maps to quota limit signal', () => {
  const events = extractVertexQuotaEventsFromText(
    '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded"}}',
    { timestamp: new Date(now).toISOString(), source: 'test' },
  );
  const telemetry = computeVertexSyntheticTelemetry(null, [row(60), row(55, { session_id: 'b' }), row(10, { session_id: 'c' })], {
    now,
    quotaEvents: events,
    quotaEventFile: '/does/not/exist.jsonl',
  });

  assert.equal(events.length, 1);
  assert.equal(telemetry.signal, 'limit_hit');
  assert.equal(telemetry.causalReason, 'GCP_QUOTA_EXHAUSTED');
  assert.equal(telemetry.latestQuotaEvent.code, 'RESOURCE_EXHAUSTED');
  assert.equal(telemetry.confidenceCap, 'med');
});

test('Vertex telemetry prefers authoritative API snapshot when present', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now).toISOString(),
      five_hour: { total_tokens: 1234, input_tokens: 900, output_tokens: 250, cache_create_tokens: 60, cache_read_tokens: 24, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, input_tokens: 7200, output_tokens: 1800, cache_create_tokens: 500, cache_read_tokens: 300, cost_usd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [], {
      now,
      vertexApiFile: snapshot,
      requireApi: true,
    });

    assert.equal(telemetry.telemetryAuthority, 'vertex-api');
    assert.equal(telemetry.synthetic, false);
    assert.equal(telemetry.estimated, false);
    assert.equal(telemetry.dataMaturity.state, 'authoritative');
    assert.equal(telemetry.fiveHour.totalTokens, 1234);
    assert.equal(telemetry.sevenDay.totalTokens, 9800);
    assert.equal(telemetry.fiveHour.costUsd, 7.25);
    assert.equal(telemetry.sevenDay.costUsd, 84.5);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry maps authoritative HTTP 429 quota events to limit-hit', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-quota-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now).toISOString(),
      five_hour: { total_tokens: 1234, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
      latest_quota_event: {
        ts: new Date(now).toISOString(),
        status: 429,
        message: 'rate limit quota exhausted',
      },
    }));

    const telemetry = computeVertexTelemetry(null, [], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'vertex-api');
    assert.equal(telemetry.signal, 'limit_hit');
    assert.equal(telemetry.causalReason, 'GCP_QUOTA_EXHAUSTED');
    assert.equal(telemetry.latestQuotaEvent.code, 'HTTP_429');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry marks strict missing-API fallback', () => {
  const telemetry = computeVertexTelemetry(null, [row(20)], {
    now,
    requireApi: true,
    vertexApiFile: '/does/not/exist.json',
  });

  assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
  assert.equal(telemetry.missingApiTelemetry, true);
  assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
});

test('Vertex telemetry rejects malformed API windows with no numeric fields', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-malformed-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now).toISOString(),
      five_hour: { total_tokens: 'abc', cost_usd: 'nan' },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test('Vertex telemetry rejects partially malformed snapshots (bad five_hour + valid seven_day)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-partial-malformed-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now).toISOString(),
      five_hour: { total_tokens: 'abc', cost_usd: 'nan' },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry rejects snapshots with explicit null fiveHour window', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-null-window-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrievedAt: new Date(now).toISOString(),
      fiveHour: null,
      sevenDay: { totalTokens: 9800, costUsd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test('Vertex telemetry rejects snapshots with malformed cost field despite valid tokens', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-bad-cost-field-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrievedAt: new Date(now).toISOString(),
      fiveHour: { totalTokens: 9800, costUsd: 'oops' },
      sevenDay: { totalTokens: 120000, costUsd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry treats partial-cost snapshots as token metrics only', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-missing-cost-field-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrievedAt: new Date(now).toISOString(),
      fiveHour: { totalTokens: 9800 },
      sevenDay: { totalTokens: 120000, costUsd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'vertex-metrics-estimate');
    assert.equal(telemetry.missingApiTelemetry, false);
    assert.equal(telemetry.estimated, true);
    assert.equal(telemetry.authoritative, false);
    assert.equal(telemetry.fiveHour.totalTokens, 9800);
    assert.equal(telemetry.sevenDay.totalTokens, 120000);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry rejects snapshots with negative token counters', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-negative-tokens-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrievedAt: new Date(now).toISOString(),
      fiveHour: { totalTokens: 9800, costUsd: 1.2 },
      sevenDay: { totalTokens: -120000, costUsd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test('Vertex telemetry rejects stale API snapshots and fails closed', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-stale-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now - 4 * 3600_000).toISOString(),
      five_hour: { total_tokens: 1234, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
      vertexApiMaxSnapshotAgeMinutes: 20,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /240\.0m old > 20\.0m max/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});


test('Vertex telemetry accepts stale snapshot when max age override is disabled', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-stale-allow-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now - 4 * 3600_000).toISOString(),
      five_hour: { total_tokens: 1234, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
      vertexApiMaxSnapshotAgeMinutes: 0,
    });

    assert.equal(telemetry.telemetryAuthority, 'vertex-api');
    assert.equal(telemetry.missingApiTelemetry, false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Vertex telemetry rejects API snapshots missing retrieved timestamp', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-api-no-retrieved-at-'));
  try {
    const snapshot = join(sandbox, 'vertex-api.json');
    writeFileSync(snapshot, JSON.stringify({
      five_hour: { total_tokens: 1234, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
    }));

    const telemetry = computeVertexTelemetry(null, [row(20)], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
      vertexApiMaxSnapshotAgeMinutes: 20,
    });

    assert.equal(telemetry.telemetryAuthority, 'local-synthetic');
    assert.equal(telemetry.missingApiTelemetry, true);
    assert.match(telemetry.apiTelemetryReason, /missing or invalid/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Vertex telemetry accepts authoritative latest_quota_event.at timestamps", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "claude-ops-vertex-api-quota-at-"));
  try {
    const snapshot = join(sandbox, "vertex-api.json");
    writeFileSync(snapshot, JSON.stringify({
      retrieved_at: new Date(now).toISOString(),
      five_hour: { total_tokens: 1234, cost_usd: 7.25 },
      seven_day: { total_tokens: 9800, cost_usd: 84.5 },
      latest_quota_event: {
        at: new Date(now).toISOString(),
        status: 429,
        message: "quota exhausted",
      },
    }));

    const telemetry = computeVertexTelemetry(null, [], {
      now,
      requireApi: true,
      vertexApiFile: snapshot,
    });

    assert.equal(telemetry.telemetryAuthority, "vertex-api");
    assert.equal(telemetry.signal, "limit_hit");
    assert.equal(telemetry.causalReason, "GCP_QUOTA_EXHAUSTED");
    assert.equal(telemetry.latestQuotaEvent.code, "HTTP_429");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
