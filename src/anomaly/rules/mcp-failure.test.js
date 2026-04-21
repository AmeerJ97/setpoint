import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkMcpFailures } from './mcp-failure.js';

describe('checkMcpFailures', () => {
  it('returns empty array for empty map', () => {
    const result = checkMcpFailures(new Map());
    assert.deepEqual(result, []);
  });

  it('returns empty array when all counts below threshold', () => {
    const counts = new Map([
      ['brave', 1],
      ['perplexity', 2],
    ]);
    const result = checkMcpFailures(counts);
    assert.deepEqual(result, []);
  });

  it('triggers when count reaches threshold', () => {
    const counts = new Map([
      ['brave', 3], // STREAK_THRESHOLD = 3
    ]);
    const result = checkMcpFailures(counts);
    assert.equal(result.length, 1);
    assert.equal(result[0].triggered, true);
    assert.equal(result[0].severity, 'warn');
    assert.ok(result[0].message.includes('brave'));
    assert.ok(result[0].message.includes('× 3'));
  });

  it('returns multiple alerts for multiple failing MCPs', () => {
    const counts = new Map([
      ['brave', 5],
      ['perplexity', 1],
      ['sentry', 4],
    ]);
    const result = checkMcpFailures(counts);
    assert.equal(result.length, 2); // brave and sentry

    const names = result.map(r => r.message);
    assert.ok(names.some(m => m.includes('brave')));
    assert.ok(names.some(m => m.includes('sentry')));
  });

  it('includes correct failure count in message', () => {
    const counts = new Map([['test-mcp', 7]]);
    const result = checkMcpFailures(counts);
    assert.ok(result[0].message.includes('× 7'));
  });

  // Input validation tests
  it('returns empty array for null/undefined', () => {
    assert.deepEqual(checkMcpFailures(null), []);
    assert.deepEqual(checkMcpFailures(undefined), []);
  });

  it('returns empty array for non-iterable', () => {
    assert.deepEqual(checkMcpFailures({}), []);
    assert.deepEqual(checkMcpFailures(42), []);
  });

  it('skips entries with invalid counts', () => {
    const counts = new Map([
      ['valid', 5],
      ['invalid', NaN],
      ['negative', -1],
    ]);
    const result = checkMcpFailures(counts);
    assert.equal(result.length, 1);
    assert.ok(result[0].message.includes('valid'));
  });
});
