import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as analytics from './index.js';

test('analytics barrel exports only real, callable functions', () => {
  const names = Object.keys(analytics);
  assert.ok(names.length > 0, 'barrel has exports');
  for (const name of names) {
    assert.equal(
      typeof analytics[name],
      'function',
      `analytics.${name} must be a function, got ${typeof analytics[name]}`,
    );
  }
});

test('analytics barrel exposes calculateRates and computeAdvisory', () => {
  assert.equal(typeof analytics.calculateRates, 'function');
  assert.equal(typeof analytics.computeAdvisory, 'function');
});
