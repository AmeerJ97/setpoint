import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authProviderLabel, detectMode, detectRuntimeMode, isCostMetered, isMaxMode, runtimeBackendLabel } from './mode.js';

const baseStdin = {
  session_id: 'sid',
  model: { id: 'claude-opus-4-7', display_name: 'Opus 4.7' },
};

test('detectRuntimeMode separates subscription auth from quota-window billing', () => {
  const runtime = detectRuntimeMode({
    ...baseStdin,
    rate_limits: {
      five_hour: { used_percentage: 10 },
      seven_day: { used_percentage: 20 },
    },
  }, {});

  assert.equal(runtime.authProvider, 'subscription');
  assert.equal(runtime.billingSignal, 'quota-window');
  assert.equal(runtime.mode, 'max');
  assert.equal(runtime.backend, 'anthropic-pro');
  assert.equal(runtime.telemetryAuthority, 'server-rate-limits');
  assert.equal(runtime.backendLabel, '[ANTHROPIC-PRO]');
  assert.equal(isMaxMode({ ...baseStdin, rate_limits: {} }, {}), true);
});

test('detectRuntimeMode treats API-key sessions without rate_limits as cost-metered', () => {
  const runtime = detectRuntimeMode(baseStdin, { ANTHROPIC_API_KEY: 'secret' });

  assert.equal(runtime.authProvider, 'api-key');
  assert.equal(runtime.billingSignal, 'cost-metered');
  assert.equal(runtime.mode, 'api');
  assert.equal(runtime.backend, 'anthropic-api');
  assert.equal(runtime.telemetryAuthority, 'local-cost');
  assert.equal(isCostMetered(baseStdin, { ANTHROPIC_API_KEY: 'secret' }), true);
});

test('detectRuntimeMode labels gateway, auth token, and console cost modes without exposing values', () => {
  assert.equal(detectRuntimeMode(baseStdin, { ANTHROPIC_BASE_URL: 'https://proxy.local' }).authProvider, 'gateway');
  assert.equal(detectRuntimeMode(baseStdin, { ANTHROPIC_AUTH_TOKEN: 'token' }).authProvider, 'auth-token');
  assert.equal(detectRuntimeMode(baseStdin, {}, { apiKeyHelper: true }).authProvider, 'api-key');
  assert.equal(detectRuntimeMode(baseStdin, {}).authProvider, 'console');
});

test('detectRuntimeMode labels cloud provider auth explicitly', () => {
  assert.equal(detectRuntimeMode(baseStdin, { CLAUDE_CODE_USE_BEDROCK: '1' }).authProvider, 'bedrock');
  const vertex = detectRuntimeMode({
    ...baseStdin,
    rate_limits: { five_hour: { used_percentage: 10 } },
  }, { CLAUDE_CODE_USE_VERTEX: 'true' });
  assert.equal(vertex.authProvider, 'vertex');
  assert.equal(vertex.billingSignal, 'cost-metered');
  assert.equal(vertex.backend, 'vertex-ai');
  assert.equal(vertex.telemetryAuthority, 'local-synthetic');
  const vertexProject = detectRuntimeMode(baseStdin, { ANTHROPIC_VERTEX_PROJECT_ID: 'project-a' });
  assert.equal(vertexProject.authProvider, 'vertex');
  assert.equal(vertexProject.detection.confidence, 'medium');
  assert.equal(detectRuntimeMode(baseStdin, { CLOUD_ML_REGION: 'us-east5' }).authProvider, 'console');
  assert.equal(vertex.backendLabel, '[VERTEX-AI]');
  assert.equal(detectRuntimeMode(baseStdin, { CLAUDE_CODE_USE_FOUNDRY: 'yes' }).authProvider, 'foundry');
});

test('legacy detectMode remains compatible for old callers', () => {
  assert.equal(detectMode(null, {}), 'unknown');
  assert.equal(detectMode(baseStdin, {}), 'api');
  assert.equal(detectMode({ ...baseStdin, rate_limits: {} }, {}), 'max');
});

test('authProviderLabel returns display-safe labels', () => {
  assert.equal(authProviderLabel('subscription'), null);
  assert.equal(authProviderLabel('api-key'), 'API');
  assert.equal(authProviderLabel('gateway'), 'Gateway');
  assert.equal(authProviderLabel('vertex'), 'Vertex');
  assert.equal(runtimeBackendLabel({ authProvider: 'vertex', billingSignal: 'cost-metered' }), '[VERTEX-AI]');
});
