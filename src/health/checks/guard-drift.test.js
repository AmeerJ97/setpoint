import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGuardDrift, guardDriftSeverity } from './guard-drift.js';

test('guard drift is informational while guard is audit-only', () => {
  assert.equal(guardDriftSeverity(15, false), 'info');
});

test('guard drift is a warning while guard enforcement is active', () => {
  assert.equal(guardDriftSeverity(15, true), 'warning');
});

test('guard drift is informational when no categories drift', () => {
  assert.equal(guardDriftSeverity(0, true), 'info');
});

test('guard drift health check includes Vertex config audit when env is active', () => {
  const prior = {
    CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
    CLOUD_ML_REGION: process.env.CLOUD_ML_REGION,
    ANTHROPIC_VERTEX_PROJECT_ID: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
  };
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.CLOUD_ML_REGION = 'us-east5';
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'project-a';
  try {
    const issue = checkGuardDrift()[0];
    assert.equal(issue.vertexConfig.active, true);
    assert.equal(issue.vertexConfig.state, 'held');
    assert.match(issue.message, /vertex:held/);
  } finally {
    restoreEnv('CLAUDE_CODE_USE_VERTEX', prior.CLAUDE_CODE_USE_VERTEX);
    restoreEnv('CLOUD_ML_REGION', prior.CLOUD_ML_REGION);
    restoreEnv('ANTHROPIC_VERTEX_PROJECT_ID', prior.ANTHROPIC_VERTEX_PROJECT_ID);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('guard drift is a warning when Vertex API telemetry bypass is enabled', () => {
  assert.equal(guardDriftSeverity(0, false, true), 'warning');
});

test('guard drift health check surfaces Vertex telemetry bypass in message and severity', () => {
  const prior = {
    CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
    CLOUD_ML_REGION: process.env.CLOUD_ML_REGION,
    ANTHROPIC_VERTEX_PROJECT_ID: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY: process.env.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY,
  };
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.CLOUD_ML_REGION = 'us-east5';
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'project-a';
  process.env.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY = '0';
  try {
    const issue = checkGuardDrift()[0];
    assert.equal(issue.apiTelemetryBypass, true);
    assert.equal(issue.severity, 'warning');
    assert.match(issue.message, /vertex-api-bypass:on/);
  } finally {
    restoreEnv('CLAUDE_CODE_USE_VERTEX', prior.CLAUDE_CODE_USE_VERTEX);
    restoreEnv('CLOUD_ML_REGION', prior.CLOUD_ML_REGION);
    restoreEnv('ANTHROPIC_VERTEX_PROJECT_ID', prior.ANTHROPIC_VERTEX_PROJECT_ID);
    restoreEnv('CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY', prior.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY);
  }
});
