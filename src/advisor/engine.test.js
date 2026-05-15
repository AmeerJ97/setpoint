import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendation } from './engine.js';

/**
 * Synthesize the minimum rates shape the engine reads. fhTte / sdTte
 * are the only fields that matter for the hard-stop ladder; window
 * level is read only for the limit_hit override.
 */
function rates({ fhTte = null, sdTte = null, peakActive = false,
                  fhLevel = 'ok', sdLevel = 'ok' } = {}) {
  return {
    fiveHourDetail: { current: 50, projected: 0.6, tte: fhTte, level: fhLevel,
      peakActive, peakFraction: peakActive ? 0.5 : 0, peakMultiplier: 1.5,
      burnFracPerMin: 0, resetIn: '2h' },
    sevenDayDetail: { current: 30, projected: 0.4, tte: sdTte, level: sdLevel,
      peakActive: false, peakFraction: 0, peakMultiplier: 1.5,
      burnFracPerMin: 0, resetIn: '5d' },
    burnRate: 100, estimatedSessions: 1,
    fiveHourProjected: 0.6, sevenDayProjected: 0.4,
  };
}

function syntheticHistory(days, samplesPerDay = 10, baseBurn = 100) {
  const out = [];
  const now = Date.now();
  for (let d = days; d >= 0; d--) {
    for (let s = 0; s < samplesPerDay; s++) {
      out.push({
        ts: new Date(now - d * 86_400_000 + s * 600_000).toISOString(),
        session_burn_rate: baseBurn + (Math.random() * 20 - 10),
        context_pct: 30 + Math.random() * 20,
      });
    }
  }
  return out;
}

describe('buildRecommendation — action ladder', () => {
  it('hard-stop fires when 5h TTE < 30 min', () => {
    const r = buildRecommendation({ rates: rates({ fhTte: 25 * 60 }) });
    assert.equal(r.tier, 'hard_stop_5h');
    assert.equal(r.signal, 'throttle');
  });

  it('hard-stop fires when 7d TTE < 12 h', () => {
    const r = buildRecommendation({ rates: rates({ sdTte: 8 * 3600 }) });
    assert.equal(r.tier, 'hard_stop_7d');
    assert.equal(r.signal, 'throttle');
  });

  it('5h TTE hard-stop wins over 7d TTE hard-stop', () => {
    const r = buildRecommendation({ rates: rates({ fhTte: 10 * 60, sdTte: 1 * 3600 }) });
    assert.equal(r.tier, 'hard_stop_5h');
  });

  it('limit_hit overrides everything', () => {
    const r = buildRecommendation({
      rates: rates({ fhTte: 10 * 60, fhLevel: 'hit' }),
    });
    assert.equal(r.tier, 'limit_hit');
    assert.equal(r.signal, 'limit_hit');
  });

  it('model swap fires on Opus + peak + burn velocity > 2.5×', () => {
    const history = syntheticHistory(8, 10, 100); // P50 ~100
    const r = buildRecommendation({
      rates: rates({ peakActive: true }),
      tokenStats: { burnRate: 400, durationMin: 60,
        recentTurnsOutput: Array(20).fill(100) },
      modelName: 'claude-opus-4-7',
      history,
    });
    assert.equal(r.tier, 'model_swap');
    assert.equal(r.signal, 'reduce');
    assert.match(r.action, /Opus.*Sonnet/i);
  });

  it('model swap does not fire off-peak even when burn is high', () => {
    const history = syntheticHistory(8, 10, 100);
    const r = buildRecommendation({
      rates: rates({ peakActive: false }),
      tokenStats: { burnRate: 400, durationMin: 60, recentTurnsOutput: [] },
      modelName: 'claude-opus-4-7',
      history,
    });
    assert.notEqual(r.tier, 'model_swap');
  });

  it('model swap does not fire on Sonnet (already smaller)', () => {
    const history = syntheticHistory(8, 10, 100);
    const r = buildRecommendation({
      rates: rates({ peakActive: true }),
      tokenStats: { burnRate: 400, durationMin: 60, recentTurnsOutput: [] },
      modelName: 'claude-sonnet-4-6',
      history,
    });
    assert.notEqual(r.tier, 'model_swap');
  });

  it('/clear fires when R:E < 3.0 with enough edits', () => {
    const r = buildRecommendation({
      rates: rates(),
      toolCounts: { Read: 4, Edit: 4 },
    });
    assert.equal(r.tier, 'clear_session');
    assert.equal(r.signal, 'reduce');
  });

  it('/clear does not fire when only 1 edit (insufficient signal)', () => {
    const r = buildRecommendation({
      rates: rates(),
      toolCounts: { Read: 1, Edit: 1 },
    });
    assert.notEqual(r.tier, 'clear_session');
  });

  it('/compact fires when context > 60%', () => {
    const r = buildRecommendation({
      rates: rates(),
      contextPercent: 75,
      toolCounts: { Read: 30, Edit: 5 }, // healthy R:E
    });
    assert.equal(r.tier, 'compact_context');
    assert.equal(r.signal, 'reduce');
  });

  it('hard-stop wins over /compact', () => {
    const r = buildRecommendation({
      rates: rates({ fhTte: 10 * 60 }),
      contextPercent: 90,
    });
    assert.equal(r.tier, 'hard_stop_5h');
  });

  it('falls through to "on track" when no rung fires', () => {
    const r = buildRecommendation({
      rates: rates(),
      contextPercent: 30,
      toolCounts: { Read: 30, Edit: 5 },
    });
    assert.equal(r.tier, 'ok');
    assert.equal(r.signal, 'increase');
  });
});

describe('buildRecommendation — confidence', () => {
  it('low confidence when session is brand new', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 5,
        recentTurnsOutput: [100, 200] },
    });
    assert.equal(r.confidence, 'low');
  });

  it('medium confidence on a half-hour-old session', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 30,
        recentTurnsOutput: Array(10).fill(100) },
    });
    assert.equal(r.confidence, 'med');
  });

  it('high confidence on a mature session', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 90,
        recentTurnsOutput: Array(30).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.confidence, 'high');
  });

  it('caps mature sessions at medium confidence while baselines warm up', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 90,
        recentTurnsOutput: Array(30).fill(100) },
      history: [],
    });
    assert.equal(r.confidence, 'med');
    assert.match(r.confidenceWhy, /baselines/);
  });

  it('caps API sessions at low confidence because quota data is absent', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 90,
        recentTurnsOutput: Array(30).fill(100) },
      mode: 'api',
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.confidence, 'low');
  });
});

describe('buildRecommendation — metrics + baselines passthrough', () => {
  it('exposes metrics block with R:E, burn, TTE, context', () => {
    const r = buildRecommendation({
      rates: rates({ fhTte: 90 * 60 }),
      toolCounts: { Read: 12, Edit: 4 },
      contextPercent: 45,
      tokenStats: { burnRate: 250 },
    });
    assert.equal(r.metrics.reads, 12);
    assert.equal(r.metrics.edits, 4);
    assert.equal(r.metrics.ratio, 3);
    assert.equal(r.metrics.burnRate, 250);
    assert.equal(r.metrics.fhTteSec, 90 * 60);
    assert.equal(r.metrics.contextPercent, 45);
  });

  it('baselines.sufficient=false when history is empty', () => {
    const r = buildRecommendation({ rates: rates() });
    assert.equal(r.baselines.sufficient, false);
  });

  it('baselines.sufficient=true when ≥7d history with ≥50 samples', () => {
    const r = buildRecommendation({
      rates: rates(),
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.baselines.sufficient, true);
    assert.ok(r.baselines.burnP90 >= r.baselines.burnP50);
  });
});

describe('buildRecommendation — API mode actions', () => {
  it('uses burn velocity for API high-burn sessions', () => {
    const r = buildRecommendation({
      rates: rates(),
      mode: 'api',
      tokenStats: { burnRate: 400, durationMin: 60, recentTurnsOutput: Array(20).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.tier, 'api_burn_high');
    assert.match(r.action, /API burn hot/);
  });

  it('describes 7d API history as a reference, not a limit', () => {
    const r = buildRecommendation({
      rates: rates(),
      mode: 'api',
      tokenStats: { burnRate: 100, durationMin: 60, recentTurnsOutput: Array(20).fill(100) },
      history: syntheticHistory(8, 10, 100),
      apiWindowRefs: {
        dataMaturity: { state: 'local_reference' },
        ref7dCostUsd: 10,
        sessionCostPct7d: 120,
      },
    });
    assert.equal(r.tier, 'api_weekly_ref_high');
    assert.match(r.action, /reference/);
    assert.doesNotMatch(`${r.action} ${r.causalReason}`, /limit/i);
  });

  it('raises API confidence to medium only with mature local cost history', () => {
    const r = buildRecommendation({
      rates: rates(),
      mode: 'api',
      tokenStats: { burnRate: 100, durationMin: 90, recentTurnsOutput: Array(30).fill(100) },
      history: syntheticHistory(8, 10, 100),
      apiWindowRefs: {
        dataMaturity: { state: 'local_reference', reason: 'mature' },
      },
    });
    assert.equal(r.confidence, 'med');
    assert.match(r.confidenceWhy, /local cost reference/);
  });
});

describe('buildRecommendation — Vertex synthetic telemetry', () => {
  it('maps Vertex RESOURCE_EXHAUSTED telemetry to a GCP quota limit hit', () => {
    const r = buildRecommendation({
      rates: { burnRate: 100, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'local-synthetic',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        signal: 'limit_hit',
        causalReason: 'GCP_QUOTA_EXHAUSTED',
        latestQuotaEvent: { code: 'RESOURCE_EXHAUSTED', causalReason: 'GCP_QUOTA_EXHAUSTED' },
        dataMaturity: { state: 'warming', reason: 'warming', samples: 1, distinctSessions: 1 },
      },
    });
    assert.equal(r.tier, 'vertex_quota_exhausted');
    assert.equal(r.signal, 'limit_hit');
    assert.match(r.causalReason, /GCP_QUOTA_EXHAUSTED/);
    assert.equal(r.confidence, 'med');
  });

  it('keeps Vertex headerless sessions low confidence instead of faking quota TTE', () => {
    const r = buildRecommendation({
      rates: { burnRate: 100, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'local-synthetic',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        signal: null,
        dataMaturity: { state: 'warming', reason: 'warming local Vertex telemetry', samples: 1, distinctSessions: 1 },
      },
      tokenStats: { burnRate: 100, durationMin: 90, recentTurnsOutput: Array(30).fill(100) },
    });
    assert.equal(r.tier, 'vertex_api_missing');
    assert.equal(r.signal, 'throttle');
    assert.equal(r.confidence, 'low');
    assert.equal(r.metrics.fhTteSec, null);
    assert.match(r.confidenceWhy, /authoritative API snapshot missing/);
  });

  it('throttles authoritative Vertex telemetry when cost fields are nonpositive for nonzero usage', () => {
    const r = buildRecommendation({
      rates: { burnRate: 220, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'vertex-api',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        telemetryAuthority: 'vertex-api',
        signal: null,
        dataMaturity: { state: 'authoritative', reason: 'api snapshot', samples: 1, distinctSessions: 1 },
        fiveHour: { totalTokens: 12000, costUsd: -0.01 },
        sevenDay: { totalTokens: 48000, costUsd: 0 },
      },
      tokenStats: { burnRate: 220, durationMin: 80, recentTurnsOutput: Array(25).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.tier, 'vertex_api_invalid_cost');
    assert.equal(r.signal, 'throttle');
    assert.equal(r.confidence, 'low');
    assert.match(r.causalReason, /nonpositive.*cost_usd/);
    assert.match(r.confidenceWhy, /nonpositive.*cost_usd/);
  });

  it('treats authoritative zero-usage vertex snapshots as non-actionable and throttles', () => {
    const r = buildRecommendation({
      rates: { burnRate: 90, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'vertex-api',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        telemetryAuthority: 'vertex-api',
        signal: null,
        dataMaturity: { state: 'authoritative', reason: 'api snapshot', samples: 1, distinctSessions: 1 },
        fiveHour: { totalTokens: 0, costUsd: 0 },
        sevenDay: { totalTokens: 0, costUsd: 0 },
      },
      tokenStats: { burnRate: 90, durationMin: 95, recentTurnsOutput: Array(30).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.confidence, 'low');
    assert.equal(r.tier, 'vertex_api_missing');
    assert.equal(r.signal, 'throttle');
    assert.match(r.causalReason, /zero total_tokens/);
  });

  it('treats authoritative negative cost as invalid even with zero usage', () => {
    const r = buildRecommendation({
      rates: { burnRate: 90, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'vertex-api',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        telemetryAuthority: 'vertex-api',
        signal: null,
        dataMaturity: { state: 'authoritative', reason: 'api snapshot', samples: 1, distinctSessions: 1 },
        fiveHour: { totalTokens: 0, costUsd: -0.1 },
        sevenDay: { totalTokens: 0, costUsd: -0.2 },
      },
      tokenStats: { burnRate: 90, durationMin: 95, recentTurnsOutput: Array(30).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.confidence, 'low');
    assert.equal(r.tier, 'vertex_api_invalid_cost');
    assert.equal(r.signal, 'throttle');
    assert.match(r.causalReason, /nonpositive.*cost_usd/);
  });

  it('treats authoritative vertex-api telemetry as high confidence when mature', () => {
    const r = buildRecommendation({
      rates: { burnRate: 240, fiveHourDetail: null, sevenDayDetail: null },
      mode: 'api',
      runtimeMode: {
        backend: 'vertex-ai',
        telemetryAuthority: 'vertex-api',
        authProvider: 'vertex',
        billingSignal: 'cost-metered',
        mode: 'api',
      },
      syntheticTelemetry: {
        telemetryAuthority: 'vertex-api',
        signal: null,
        dataMaturity: { state: 'authoritative', reason: 'api snapshot', samples: 1, distinctSessions: 1 },
        fiveHour: { totalTokens: 12000, costUsd: 4.2 },
        sevenDay: { totalTokens: 48000, costUsd: 18.3 },
      },
      tokenStats: { burnRate: 240, durationMin: 95, recentTurnsOutput: Array(30).fill(100) },
      history: syntheticHistory(8, 10, 100),
    });
    assert.equal(r.confidence, 'high');
    assert.equal(r.tier, 'vertex_burn_high');
    assert.equal(r.signal, 'reduce');
    assert.match(r.causalReason, /authoritative Vertex burn/);
  });
});
