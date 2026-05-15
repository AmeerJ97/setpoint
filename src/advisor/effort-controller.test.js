import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './effort-controller.js';

const OPUS_47 = 'claude-opus-4-7';

const base = {
  contextPct: 20,
  burnVelocity: 1.0,
  ratio: 5.0,
  current: 'high',
  modelName: OPUS_47,
  confidence: 'high',
  lastSwap: null,
  now: 1_700_000_000_000,
};

test('decide: non-Opus-4-7 model → null', () => {
  const r = decide({ ...base, modelName: 'claude-sonnet-4-6' });
  assert.equal(r.target, null);
  assert.match(r.reason, /not-opus/);
});

test('decide: ctx ≥ 70% → demote to medium', () => {
  const r = decide({ ...base, current: 'xhigh', contextPct: 72 });
  assert.equal(r.target, 'medium');
  assert.match(r.reason, /ctx 72/);
});

test('decide: burnVelocity ≥ 2× → demote to medium', () => {
  const r = decide({ ...base, current: 'xhigh', burnVelocity: 2.5 });
  assert.equal(r.target, 'medium');
});

test('decide: ctx ∈ [50,70) → promote/hold at high', () => {
  const r = decide({ ...base, current: 'xhigh', contextPct: 55 });
  assert.equal(r.target, 'high');
});

test('decide: R:E below WARN → cap to high', () => {
  const r = decide({ ...base, current: 'xhigh', ratio: 1.5, contextPct: 20 });
  assert.equal(r.target, 'high');
  assert.match(r.reason, /R:E/);
});

test('decide: deep-work promotion to xhigh when earned', () => {
  const r = decide({ ...base, current: 'high', contextPct: 15, burnVelocity: 0.3, ratio: 6.0 });
  assert.equal(r.target, 'xhigh');
});

test('decide: deep-work blocked when confidence is low', () => {
  const r = decide({ ...base, current: 'high', contextPct: 15, burnVelocity: 0.3, ratio: 6.0, confidence: 'low' });
  assert.equal(r.target, null);
});

test('decide: no change when target equals current', () => {
  const r = decide({ ...base, current: 'medium', contextPct: 75 });
  assert.equal(r.target, null);
  assert.match(r.reason, /already/);
});

test('decide: cooldown blocks rapid swap', () => {
  const lastSwap = { ts: base.now - 5 * 60 * 1000, target: 'high', contextPct: 20 };
  const r = decide({ ...base, current: 'xhigh', contextPct: 72, lastSwap });
  assert.equal(r.target, null);
  assert.match(r.reason, /cooldown/);
});

test('decide: small context delta blocks swap', () => {
  const lastSwap = { ts: base.now - 15 * 60 * 1000, target: 'high', contextPct: 68 };
  const r = decide({ ...base, current: 'high', contextPct: 70, lastSwap });
  assert.equal(r.target, null);
  assert.match(r.reason, /delta/);
});

test('decide: large context delta overrides small cooldown concern', () => {
  const lastSwap = { ts: base.now - 15 * 60 * 1000, target: 'high', contextPct: 10 };
  const r = decide({ ...base, current: 'high', contextPct: 75, lastSwap });
  assert.equal(r.target, 'medium');
});

test('decide: missing contextPct → null', () => {
  const r = decide({ ...base, contextPct: NaN });
  assert.equal(r.target, null);
});
