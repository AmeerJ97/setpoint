import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeAdvisory } from './advisor.js';

// Helper: create rates with detail objects matching the new engine output
function makeRates(fiveHourPct, sevenDayPct, fiveHourProj, sevenDayProj, burn = 100) {
  return {
    fiveHourProjected: fiveHourProj,
    sevenDayProjected: sevenDayProj,
    burnRate: burn,
    fiveHourDetail: fiveHourPct !== null ? {
      current: fiveHourPct,
      projected: fiveHourProj,
      tte: null,
      burnFracPerMin: 0,
      resetIn: '2h',
      level: classifyLevel(fiveHourPct, fiveHourProj),
    } : null,
    sevenDayDetail: sevenDayPct !== null ? {
      current: sevenDayPct,
      projected: sevenDayProj,
      tte: null,
      burnFracPerMin: 0,
      resetIn: '5d',
      level: classifyLevel(sevenDayPct, sevenDayProj),
    } : null,
    estimatedSessions: 1,
  };
}

function classifyLevel(current, projected) {
  if (current === 100) return 'hit';
  if (projected > 0.90) return 'critical';
  if (projected > 0.70 || (current !== null && current > 80)) return 'tight';
  if (projected > 0.50 || (current !== null && current > 50)) return 'watch';
  return 'ok';
}

describe('computeAdvisory', () => {
  it('returns increase when plenty of headroom', () => {
    const rates = makeRates(40, 20, 0.50, 0.30, 100);
    const usage = { fiveHour: 40, sevenDay: 20, fiveHourResetAt: new Date(Date.now() + 7200000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'increase');
    assert.equal(result.burnLevel, 'low');
  });

  it('returns throttle when 5hr critical', () => {
    const rates = makeRates(90, 30, 0.95, 0.40, 300);
    const usage = { fiveHour: 90, sevenDay: 30, fiveHourResetAt: new Date(Date.now() + 3600000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'throttle');
    assert.equal(result.fiveHour.level, 'critical');
  });

  it('returns reduce when weekly tight', () => {
    const rates = makeRates(40, 75, 0.50, 0.85, 100);
    const usage = { fiveHour: 40, sevenDay: 75, fiveHourResetAt: new Date(Date.now() + 7200000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'reduce');
    assert.equal(result.sevenDay.level, 'tight');
  });

  it('returns throttle when weekly critical (>90% projected)', () => {
    const rates = makeRates(40, 85, 0.50, 0.95, 100);
    const usage = { fiveHour: 40, sevenDay: 85, fiveHourResetAt: new Date(Date.now() + 7200000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'throttle');
    assert.equal(result.sevenDay.level, 'critical');
  });

  it('returns limit_hit when at 100%', () => {
    const rates = makeRates(100, 40, 1, 0.50, 0);
    const usage = { fiveHour: 100, sevenDay: 40, fiveHourResetAt: new Date(Date.now() + 3600000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'limit_hit');
    assert.equal(result.fiveHour.level, 'hit');
  });

  it('returns reduce when 5hr tight and high burn', () => {
    const rates = makeRates(70, 30, 0.75, 0.40, 1200);
    const usage = { fiveHour: 70, sevenDay: 30, fiveHourResetAt: new Date(Date.now() + 3600000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(result.signal, 'reduce');
    assert.equal(result.burnLevel, 'high');
  });

  it('returns nominal for no usage data', () => {
    const rates = makeRates(null, null, 0, 0, 0);
    const result = computeAdvisory(rates, null);
    assert.equal(result.signal, 'nominal');
  });

  it('includes detail and session count', () => {
    const rates = makeRates(50, 35, 0.60, 0.45, 500);
    rates.estimatedSessions = 2;
    const usage = { fiveHour: 50, sevenDay: 35, fiveHourResetAt: new Date(Date.now() + 7200000), sevenDayResetAt: new Date(Date.now() + 500000000) };
    const result = computeAdvisory(rates, usage);
    assert.equal(typeof result.fiveHour.current, 'number');
    assert.equal(typeof result.fiveHour.projected, 'number');
    assert.equal(result.burnLevel, 'medium');
    assert.equal(result.estimatedSessions, 2);
  });
});
