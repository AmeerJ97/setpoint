import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCachePathologies } from './cache-pathology.js';

test('cache pathology warns when cache dominates token mix', () => {
  const alerts = checkCachePathologies({
    inputTokens: 1000,
    outputTokens: 1000,
    cacheCreateTokens: 80_000,
    cacheReadTokens: 10_000,
  });
  assert.ok(alerts.some(a => a.type === 'cache-heavy-session'));
});

test('cache pathology warns on cache writes with no later reads', () => {
  const alerts = checkCachePathologies({
    cacheCreateTokens: 75_000,
    cacheReadTokens: 0,
    apiCalls: 3,
  });
  assert.ok(alerts.some(a => a.type === 'cache-low-reuse'));
  assert.ok(alerts.some(a => a.type === 'cache-read-missing'));
});

test('cache pathology surfaces transcript hash markers', () => {
  const alerts = checkCachePathologies({ cchHashMutationCount: 2 });
  assert.ok(alerts.some(a => a.type === 'transcript-cache-hash-marker'));
});
