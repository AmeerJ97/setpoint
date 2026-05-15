import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAdvisorLine } from './advisor.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('critical anomaly overrides everything', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [{ severity: 'critical', message: 'rogue agent' }],
    advisory: { signal: 'increase' },
  }));
  assert.match(line, /⚠ rogue agent/);
});

test('warn anomaly rides as a trailing badge, does NOT take over', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [{ severity: 'warn', message: 'cache degraded' }],
    advisory: {
      signal: 'nominal', action: 'proceed', confidence: 'med',
      fiveHour: { current: 20, projected: 0.3, level: 'ok' },
    },
    tokenStats: { burnRate: 100 },
  }));
  // Main advisor content still renders (gauge, action badge).
  assert.match(line, /5h/);
  assert.match(line, /proceed/);
  // Warn anomaly appended as a △ badge, not a full-line takeover.
  assert.match(line, /△ cache degraded/);
});

test('warn anomaly co-exists with a reduce/throttle signal', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [{ severity: 'warn', message: 'minor thing' }],
    advisory: {
      signal: 'throttle', action: 'throttle now', confidence: 'high',
      fiveHour: { current: 92, projected: 0.99, level: 'critical' },
    },
    tokenStats: { burnRate: 900 },
  }));
  assert.match(line, /throttle now/);
  // Warn stays visible alongside the primary action.
  assert.match(line, /△ minor thing/);
});

test('combined gauge renders current and projection for primary window', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce',
      fiveHour: { current: 62, projected: 0.78, level: 'tight' },
      sevenDay: { current: 38, projected: 0.52, level: 'watch' },
    },
    tokenStats: { burnRate: 314 },
  }));
  // 5h is the more-pressing window (78 > 52), so it should be the chosen gauge
  assert.match(line, /5h/);
  assert.match(line, /62→78/);
  // Burn moved to Tokens line — advisor must not duplicate it.
  assert.doesNotMatch(line, /burn/);
  assert.doesNotMatch(line, /314t\/m/);
});

test('subscription advisor line leaves backend identity to Model line', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    billingSignal: 'quota-window',
    runtimeMode: {
      authProvider: 'subscription',
      billingSignal: 'quota-window',
      mode: 'max',
      backend: 'anthropic-pro',
      telemetryAuthority: 'server-rate-limits',
    },
    advisory: {
      signal: 'increase',
      action: 'on track',
      confidence: 'med',
      fiveHour: { current: 20, projected: 0.3, level: 'ok' },
      sevenDay: { current: 10, projected: 0.2, level: 'ok' },
    },
  }));
  assert.match(line, /Advisor\s+5h/);
  assert.doesNotMatch(line, /\[ANTHROPIC-PRO\]/);
});


test('Vertex advisor line shows authoritative telemetry badge when api-backed', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    billingSignal: 'cost-metered',
    authProvider: 'vertex',
    mode: 'api',
    runtimeMode: {
      authProvider: 'vertex',
      billingSignal: 'cost-metered',
      mode: 'api',
      backend: 'vertex-ai',
      telemetryAuthority: 'vertex-api',
    },
    apiWindowRefs: {
      sessionCostUsd: 1.10,
      ref7dCostUsd: null,
    },
    vertexTelemetry: {
      telemetryAuthority: 'vertex-api',
      dataMaturity: { state: 'authoritative' },
    },
    tokenStats: { durationMin: 30 },
    advisory: {
      signal: 'reduce',
      action: 'Vertex burn hot',
      confidence: 'high',
      tier: 'vertex_burn_high',
    },
  }));
  assert.match(line, /billing:api authoritative/);
});


test('Vertex advisor line treats zero API cost as authoritative data', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    billingSignal: 'cost-metered',
    authProvider: 'vertex',
    mode: 'api',
    runtimeMode: {
      authProvider: 'vertex',
      billingSignal: 'cost-metered',
      mode: 'api',
      backend: 'vertex-ai',
      telemetryAuthority: 'vertex-api',
    },
    apiWindowRefs: {
      sessionCostUsd: 0,
      ref7dCostUsd: 0,
    },
    vertexTelemetry: {
      telemetryAuthority: 'vertex-api',
      dataMaturity: { state: 'authoritative' },
      fiveHour: { costUsd: 0 },
      sevenDay: { costUsd: 0 },
    },
    tokenStats: { durationMin: 30 },
    advisory: {
      signal: 'nominal',
      action: 'hold',
      confidence: 'high',
      tier: 'ok',
    },
  }));
  assert.match(line, /\$0.00\/h/);
  assert.match(line, /5h:\$0.00/);
  assert.match(line, /7d:\$0.00/);
  assert.doesNotMatch(line, /api-cost missing/);
});

test('Vertex advisor line avoids duplicating API-missing details when telemetry is synthetic', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    billingSignal: 'cost-metered',
    authProvider: 'vertex',
    mode: 'api',
    runtimeMode: {
      authProvider: 'vertex',
      billingSignal: 'cost-metered',
      mode: 'api',
      backend: 'vertex-ai',
      telemetryAuthority: 'local-synthetic',
    },
    apiWindowRefs: {
      sessionCostUsd: 1.24,
      ref7dCostUsd: null,
    },
    vertexTelemetry: {
      dataMaturity: { state: 'warming' },
    },
    tokenStats: { durationMin: 30 },
    advisory: {
      signal: 'limit_hit',
      action: 'pause Vertex traffic',
      confidence: 'med',
      tier: 'vertex_quota_exhausted',
    },
  }));
  assert.doesNotMatch(line, /\[VERTEX-AI\]/);
  assert.match(line, /collect api-cost/);
  assert.match(line, /billing:missing/);
  assert.doesNotMatch(line, /api-cost missing/);
  assert.doesNotMatch(line, /telemetry:api-missing/);
  assert.doesNotMatch(line, /TTE/);
});

test('narrow mode drops the gauge but keeps the rec', () => {
  const line = strip(renderAdvisorLine({
    narrow: true,
    advisory: {
      signal: 'increase',
      action: 'on track — proceed',
      fiveHour: { current: 20, projected: 0.25, level: 'ok' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.doesNotMatch(line, /5h.*▕/, 'no gauge in narrow mode');
  assert.match(line, /on track/);
});

test('renders the engine action verbatim when present', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce',
      action: '/compact — context > 60%',
      confidence: 'high',
      fiveHour: { current: 40, projected: 0.5, level: 'watch' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.match(line, /\/compact/);
});

test('confidence renders as an explicit conf: field', () => {
  const high = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce', action: '/compact', confidence: 'high',
      fiveHour: { current: 40, projected: 0.5, level: 'watch' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.match(high, /conf:high/);

  const low = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce', action: '/clear', confidence: 'low',
      fiveHour: { current: 40, projected: 0.5, level: 'watch' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.match(low, /conf:low/);

  const missing = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'nominal', action: 'proceed',
      fiveHour: { current: 10, projected: 0.2, level: 'ok' },
    },
    tokenStats: { burnRate: 0 },
  }));
  // Confidence is always supplied by the engine; missing → treated as low.
  assert.match(missing, /conf:low/);
});

test('TTE renders in red on 5h window when under 2 hours remain', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce',
      fiveHour: { current: 85, projected: 0.99, level: 'critical', tte: 25 * 60 },
    },
    tokenStats: { burnRate: 500 },
  }));
  assert.match(line, /TTE 25m/);
});

test('TTE renders dim but always visible when outside the danger band', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'nominal',
      fiveHour: { current: 20, projected: 0.3, level: 'ok', tte: 4 * 3600 },
    },
    tokenStats: { burnRate: 50 },
  }));
  // Always visible — not gated by danger band.
  assert.match(line, /TTE 4h/);
});

test('TTE renders -- placeholder when no projection exists', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'nominal', action: 'warming up', confidence: 'low',
      fiveHour: null, sevenDay: null,
    },
    tokenStats: { burnRate: 0 },
  }));
  assert.match(line, /TTE --/);
});

test('no advisory + no anomaly falls back to "no data"', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [],
    advisory: null,
  }));
  assert.match(line, /no data/);
});

test('placeholder gauge rail renders when advisory has no projection', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'nominal',
      action: 'warming up',
      confidence: 'low',
      fiveHour: null,
      sevenDay: null,
    },
    tokenStats: { burnRate: 0 },
  }));
  // The rail should always render — even when both windows are null.
  // Placeholder signature: dim rail with a `~--→--` marker.
  assert.match(line, /▕─+▏/, 'expected dim rail when no projection');
  assert.match(line, /~--→--/, 'expected placeholder marker');
});

test('peak ⚡ glyph renders on advisor gauge when peak window active', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce',
      fiveHour: {
        current: 62, projected: 0.78, level: 'tight',
        peakActive: true, peakMultiplier: 1.5, peakFraction: 1,
      },
    },
    tokenStats: { burnRate: 200 },
  }));
  assert.match(line, /⚡/, 'expected ⚡ glyph on advisor when peak active');
});

test('low-confidence + tier=ok dims the badge and adds warming-up suffix', () => {
  const raw = renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'increase', action: 'on track', confidence: 'low', tier: 'ok',
      fiveHour: { current: 10, projected: 0.15, level: 'ok' },
    },
    tokenStats: { burnRate: 50 },
  });
  const line = strip(raw);
  assert.match(line, /~ on track — warming up/);
  // Must NOT render the green ▲ full-color badge in this state.
  assert.doesNotMatch(raw, /\x1b\[32m▲ on track/);
});

test('low-confidence but actionable tier (model_swap) keeps full-color badge', () => {
  const raw = renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce', action: 'swap Opus → Sonnet',
      confidence: 'low', tier: 'model_swap',
      fiveHour: { current: 70, projected: 0.9, level: 'tight' },
    },
    tokenStats: { burnRate: 400 },
  });
  const line = strip(raw);
  assert.match(line, /▼ swap Opus → Sonnet/);
  assert.doesNotMatch(line, /warming up/);
});

test('med+ confidence never dims the badge', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'increase', action: 'on track', confidence: 'med', tier: 'ok',
      fiveHour: { current: 20, projected: 0.3, level: 'ok' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.match(line, /▲ on track/);
  assert.doesNotMatch(line, /warming up/);
});

test('peak ⚡ glyph hidden on advisor when peak share is negligible', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    advisory: {
      signal: 'reduce',
      fiveHour: {
        current: 62, projected: 0.78, level: 'tight',
        peakActive: false, peakMultiplier: 1.5, peakFraction: 0.05,
      },
    },
    tokenStats: { burnRate: 200 },
  }));
  assert.doesNotMatch(line, /⚡/);
});
