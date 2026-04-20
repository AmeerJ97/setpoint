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
    assert.equal(r.confidence, 'medium');
  });

  it('high confidence on a mature session', () => {
    const r = buildRecommendation({
      rates: rates(),
      tokenStats: { burnRate: 100, durationMin: 90,
        recentTurnsOutput: Array(30).fill(100) },
    });
    assert.equal(r.confidence, 'high');
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
