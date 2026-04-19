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
  assert.match(line, /ALERT: rogue agent/);
});

test('warn anomaly overrides a nominal/increase signal', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [{ severity: 'warn', message: 'cache degraded' }],
    advisory: { signal: 'nominal' },
  }));
  assert.match(line, /△ cache degraded/);
});

test('warn anomaly does NOT override a reduce/throttle signal', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [{ severity: 'warn', message: 'minor thing' }],
    advisory: {
      signal: 'throttle',
      fiveHour: { current: 92, projected: 0.99, level: 'critical' },
    },
  }));
  assert.match(line, /throttle/);
  assert.doesNotMatch(line, /minor thing/);
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
  assert.match(line, /burn/);
  assert.match(line, /314t\/m/);
});

test('narrow mode drops the gauge but keeps the rec and burn', () => {
  const line = strip(renderAdvisorLine({
    narrow: true,
    advisory: {
      signal: 'increase',
      fiveHour: { current: 20, projected: 0.25, level: 'ok' },
    },
    tokenStats: { burnRate: 100 },
  }));
  assert.doesNotMatch(line, /5h.*▕/, 'no gauge in narrow mode');
  assert.match(line, /safe/);
});

test('no advisory + no anomaly falls back to "no data"', () => {
  const line = strip(renderAdvisorLine({
    narrow: false,
    anomalies: [],
    advisory: null,
  }));
  assert.match(line, /no data/);
});
