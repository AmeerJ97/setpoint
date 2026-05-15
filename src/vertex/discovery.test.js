import test from 'node:test';
import assert from 'node:assert/strict';
import { hostForLocation, normalizeDiscoveryResponse, resolveLocations } from './discovery.js';

test('hostForLocation handles global, multiregion, and regional hosts', () => {
  assert.equal(hostForLocation('global'), 'aiplatform.googleapis.com');
  assert.equal(hostForLocation('us'), 'aiplatform.us.rep.googleapis.com');
  assert.equal(hostForLocation('us-east5'), 'us-east5-aiplatform.googleapis.com');
});

test('normalizeDiscoveryResponse extracts model ids and action urls', () => {
  const models = normalizeDiscoveryResponse({
    publisherModels: [{
      name: 'publishers/anthropic/models/claude-haiku-4-5',
      versionId: '20251001',
      launchStage: 'GA',
      publisherModelTemplate: 'projects/{project}/locations/{location}/publishers/google/models/claude-haiku-4-5@20251001',
      supportedActions: {
        requestAccess: { references: { global: { uri: 'https://example/request' } } },
      },
    }],
  }, 'global');
  assert.equal(models[0].modelId, 'claude-haiku-4-5@20251001');
  assert.equal(models[0].requestAccessUrl, 'https://example/request');
  assert.equal(models[0].supportsOneHourCache, true);
});

test('resolveLocations expands common and explicit lists', () => {
  assert.ok(resolveLocations('common').includes('global'));
  assert.deepEqual(resolveLocations('global,us-east5'), ['global', 'us-east5']);
});
