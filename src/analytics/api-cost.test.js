import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeApiWindowRefs } from './api-cost.js';

function row(ageMs, cost, extra = {}) {
  return {
    ts: new Date(Date.now() - ageMs).toISOString(),
    session_cost_usd: cost,
    ...extra,
  };
}

test('API refs use billable session estimate including cache tokens', () => {
  const refs = computeApiWindowRefs({
    totalInput: 1_000_000,
    totalOutput: 1_000_000,
    totalCacheCreate: 1_000_000,
    totalCacheRead: 1_000_000,
  }, 'claude-opus-4-7', []);

  assert.equal(refs.sessionCostUsd, 36.75);
  assert.equal(refs.ref5hCostUsd, null);
  assert.equal(refs.ref7dCostUsd, null);
});

test('API refs prefer native statusLine session cost when available', () => {
  const refs = computeApiWindowRefs({
    totalInput: 1_000_000,
    totalOutput: 1_000_000,
    totalCacheCreate: 1_000_000,
    totalCacheRead: 1_000_000,
  }, 'claude-opus-4-7', [], {
    nativeSessionCostUsd: 12.34,
    nativeCostAuthority: 'statusline-cost',
  });

  assert.equal(refs.sessionCostUsd, 12.34);
  assert.equal(refs.sessionCostAuthority, 'statusline-cost');
});

test('API refs surface unknown pricing metadata for HUD labelling', () => {
  const refs = computeApiWindowRefs({ totalInput: 1_000_000 }, 'future-model-999', []);

  assert.equal(refs.sessionCostUsd, 0);
  assert.equal(refs.pricingKnown, false);
  assert.equal(refs.pricingModelId, 'future-model-999');
});

test('API refs ignore legacy ambiguous session_cost rows', () => {
  const refs = computeApiWindowRefs({}, 'claude-opus-4-7', [
    row(60_000, 2.5),
    row(120_000, 1.5, { cost_kind: 'generation_reference' }),
  ]);

  assert.equal(refs.historySamples, 0);
  assert.equal(refs.ref5hCostUsd, null);
  assert.equal(refs.ref7dCostUsd, null);
});

test('API refs wait for mature local history before rendering references', () => {
  const refs = computeApiWindowRefs({}, 'claude-opus-4-7', [
    row(60_000, 2.0, { cost_kind: 'api_billable_estimate', session_id: 'a' }),
    row(120_000, 1.0, { cost_kind: 'api_billable_estimate', session_id: 'b' }),
  ]);

  assert.equal(refs.historySamples, 2);
  assert.equal(refs.dataMaturity.state, 'warming');
  assert.equal(refs.ref7dCostUsd, null);
  assert.equal(refs.ref5hCostUsd, null);
});

test('API refs aggregate mature api_billable_estimate history as local spend reference', () => {
  const refs = computeApiWindowRefs({}, 'claude-opus-4-7', [
    row(60 * 60_000, 2.0, { cost_kind: 'api_billable_estimate', session_id: 'a' }),
    row(55 * 60_000, 1.0, { cost_kind: 'api_billable_estimate', session_id: 'b' }),
    row(50 * 60_000, 0.5, { cost_kind: 'api_billable_estimate', session_id: 'b' }),
    row(180_000, 9.0, { cost_kind: 'generation_reference', session_id: 'c' }),
  ]);

  assert.equal(refs.historySamples, 3);
  assert.equal(refs.dataMaturity.state, 'local_reference');
  assert.equal(refs.ref7dCostUsd, 3.5);
  assert.equal(refs.ref5hCostUsd, 3.5);
});

test('API refs exclude the current session from local references', () => {
  const refs = computeApiWindowRefs({}, 'claude-opus-4-7', [
    row(60 * 60_000, 20.0, { cost_kind: 'api_billable_estimate', session_id: 'current' }),
    row(55 * 60_000, 1.0, { cost_kind: 'api_billable_estimate', session_id: 'a' }),
    row(50 * 60_000, 0.5, { cost_kind: 'api_billable_estimate', session_id: 'b' }),
    row(45 * 60_000, 0.5, { cost_kind: 'api_billable_estimate', session_id: 'b' }),
  ], { currentSessionId: 'current' });

  assert.equal(refs.ref7dCostUsd, 2.0);
});
