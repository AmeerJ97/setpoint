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
  assert.match(missing, /conf:--/);
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
