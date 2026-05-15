import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'claude-ops-guard-validation-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');

const { collectGuardValidationState } = await import('./guard-validation.js');

test('guard validation reports documented controls as held when env matches the audit contract', () => {
  const state = collectGuardValidationState({
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
    CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '500000',
    MAX_MCP_OUTPUT_TOKENS: '500000',
    DISABLE_PROMPT_CACHING: '0',
    ENABLE_PROMPT_CACHING_1H: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    MAX_THINKING_TOKENS: '128000',
    CLAUDE_CODE_DISABLE_THINKING: '0',
  }, { settingsPath: '/does/not/exist/settings.json' });

  assert.equal(state.posture, 'audit-first');
  assert.equal(state.summary.categories.total, 17);
  assert.equal(state.summary.categories.docsBacked > 0, true);
  assert.equal(state.summary.controls.drift, 0);
  assert.equal(state.controls.find(c => c.name === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS').state, 'held');
  assert.equal(state.controls.find(c => c.name === 'MAX_THINKING_TOKENS').state, 'info');
  assert.equal(state.controls.find(c => c.name === 'ENABLE_TOOL_SEARCH').state, 'info');
});

test('guard validation only enforces fixed thinking token budget when adaptive thinking is disabled', () => {
  const state = collectGuardValidationState({
    MAX_THINKING_TOKENS: '10000',
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
  }, { settingsPath: '/does/not/exist/settings.json' });

  const thinkingBudget = state.controls.find(c => c.name === 'MAX_THINKING_TOKENS');
  assert.equal(thinkingBudget.state, 'drift');
  assert.equal(thinkingBudget.expected, '>=128000');
});

test('guard validation flags missing expected documented controls as drift', () => {
  const state = collectGuardValidationState({}, { settingsPath: '/does/not/exist/settings.json' });

  assert.equal(state.summary.controls.drift > 0, true);
  assert.equal(state.controls.find(c => c.name === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS').state, 'drift');
  assert.equal(state.controls.find(c => c.name === 'ENABLE_PROMPT_CACHING_1H').state, 'drift');
  assert.equal(state.controls.find(c => c.name === 'DISABLE_PROMPT_CACHING').state, 'held');
});

test('guard validation reads documented controls from settings.env when process env is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-guard-validation-settings-'));
  const settingsPath = join(dir, 'settings.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    env: {
      ENABLE_PROMPT_CACHING_1H: '1',
    },
  }));

  try {
    const state = collectGuardValidationState({}, { settingsPath });
    const control = state.controls.find(c => c.name === 'ENABLE_PROMPT_CACHING_1H');
    assert.equal(control.state, 'held');
    assert.equal(control.source, 'settings.env');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});
