import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAdvisory } from './advisor.js';

/**
 * The advisor adapter is now a thin wrapper over `src/advisor/engine.js`.
 * These tests validate (1) the legacy fields the HUD renderer still reads
 * (signal, fiveHour/sevenDay passthrough, burnLevel, estimatedSessions)
 * and (2) the new fields the engine surfaces (action, confidence, tier,
 * causalReason, baselines, metrics).
 *
 * The full ladder behavior is exercised in src/advisor/engine.test.js.
 */

function makeRates({ fiveHourPct = 40, sevenDayPct = 20, fhProj = 0.5, sdProj = 0.3,
                     burn = 100, fhTte = null, sdTte = null, fhLevel = null, sdLevel = null,
                     peakActive = false } = {}) {
  return {
    fiveHourProjected: fhProj,
    sevenDayProjected: sdProj,
    burnRate: burn,
    estimatedSessions: 1,
    fiveHourDetail: fiveHourPct === null ? null : {
      current: fiveHourPct,
      projected: fhProj,
      tte: fhTte,
      burnFracPerMin: 0,
      resetIn: '2h',
      level: fhLevel ?? classifyLevel(fiveHourPct, fhProj),
      peakActive, peakFraction: peakActive ? 0.5 : 0, peakMultiplier: 1.5,
    },
    sevenDayDetail: sevenDayPct === null ? null : {
      current: sevenDayPct,
      projected: sdProj,
      tte: sdTte,
      burnFracPerMin: 0,
      resetIn: '5d',
      level: sdLevel ?? classifyLevel(sevenDayPct, sdProj),
      peakActive: false, peakFraction: 0, peakMultiplier: 1.5,
    },
  };
}

function classifyLevel(current, projected) {
  if (current === 100) return 'hit';
  if (projected > 0.90) return 'critical';
  if (projected > 0.70 || (current !== null && current > 80)) return 'tight';
  if (projected > 0.50 || (current !== null && current > 50)) return 'watch';
  return 'ok';
}

describe('computeAdvisory (engine adapter)', () => {
  it('passes window levels through to the display layer', () => {
    const rates = makeRates({ fiveHourPct: 90, fhProj: 0.95, fhLevel: 'critical' });
    const usage = { fiveHour: 90, sevenDay: 30,
      fiveHourResetAt: new Date(Date.now() + 3600000),
      sevenDayResetAt: new Date(Date.now() + 5e8) };
    const result = computeAdvisory(rates, usage, { history: [] });
    assert.equal(result.fiveHour.level, 'critical');
  });

  it('hard-stops when 5h TTE drops under 30 min', () => {
    const rates = makeRates({ fhTte: 20 * 60 });
    const result = computeAdvisory(rates, null, { history: [] });
    assert.equal(result.signal, 'throttle');
    assert.equal(result.tier, 'hard_stop_5h');
    assert.match(result.action, /stop now/i);
    assert.match(result.causalReason, /5h TTE/);
  });

  it('hard-stops when 7d TTE drops under 12 h', () => {
    const rates = makeRates({ sdTte: 6 * 3600 });
    const result = computeAdvisory(rates, null, { history: [] });
    assert.equal(result.signal, 'throttle');
    assert.equal(result.tier, 'hard_stop_7d');
  });

  it('returns limit_hit signal when 5h window is at 100%', () => {
    const rates = makeRates({ fiveHourPct: 100, fhProj: 1, fhLevel: 'hit' });
    const usage = { fiveHour: 100, sevenDay: 40,
      fiveHourResetAt: new Date(Date.now() + 3600000),
      sevenDayResetAt: new Date(Date.now() + 5e8) };
    const result = computeAdvisory(rates, usage, { history: [] });
    assert.equal(result.signal, 'limit_hit');
    assert.equal(result.fiveHour.level, 'hit');
  });

  it('recommends /clear when R:E ratio is below 3.0', () => {
    const rates = makeRates();
    const result = computeAdvisory(rates, null, {
      history: [],
      toolCounts: { Read: 4, Edit: 4 }, // ratio 1.0
    });
    assert.equal(result.tier, 'clear_session');
    assert.equal(result.signal, 'reduce');
    assert.match(result.action, /\/clear/);
  });

  it('recommends /compact when context exceeds 60%', () => {
    const rates = makeRates();
    const result = computeAdvisory(rates, null, {
      history: [],
      contextPercent: 72,
      toolCounts: { Read: 30, Edit: 5 }, // ratio 6, R:E ladder skipped
    });
    assert.equal(result.tier, 'compact_context');
    assert.equal(result.signal, 'reduce');
    assert.match(result.action, /\/compact/);
  });

  it('returns "on track" when no ladder rung fires', () => {
    const rates = makeRates({ burn: 100 });
    const result = computeAdvisory(rates, null, {
      history: [],
      toolCounts: { Read: 30, Edit: 5 },
      contextPercent: 30,
    });
    assert.equal(result.tier, 'ok');
    assert.equal(result.signal, 'increase');
  });

  it('exposes confidence based on session duration + turn count', () => {
    const rates = makeRates();
    const young = computeAdvisory(rates, null, {
      history: [],
      tokenStats: { burnRate: 100, durationMin: 5, recentTurnsOutput: [100, 200] },
    });
    assert.equal(young.confidence, 'low');

    const mature = computeAdvisory(rates, null, {
      history: [],
      tokenStats: { burnRate: 100, durationMin: 90,
        recentTurnsOutput: Array(30).fill(100) },
    });
    assert.equal(mature.confidence, 'high');
  });

  it('preserves burnLevel + estimatedSessions for backward compat', () => {
    const rates = makeRates({ burn: 600 });
    rates.estimatedSessions = 3;
    const result = computeAdvisory(rates, null, { history: [] });
    assert.equal(result.burnLevel, 'medium');
    assert.equal(result.estimatedSessions, 3);
  });

  it('exposes engine metrics + baselines on the advisory', () => {
    const result = computeAdvisory(makeRates(), null, {
      history: [],
      toolCounts: { Read: 10, Edit: 2 },
    });
    assert.ok(typeof result.metrics === 'object');
    assert.equal(result.metrics.reads, 10);
    assert.equal(result.metrics.edits, 2);
    assert.ok(typeof result.baselines === 'object');
    assert.equal(result.baselines.sufficient, false);
  });
});
