import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPromptCacheMode,
  contextWindowForModel,
  inspectPromptCacheConfig,
  normalizePromptCacheMode,
  resolveConfiguredModel,
  supportsOneHourPromptCache,
} from './prompt-cache.js';

test('prompt cache config resolves default 5m with 1h recommendation on supported model', () => {
  const cfg = inspectPromptCacheConfig({
    model: 'haiku',
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5@20251001' },
  }, {});
  assert.equal(cfg.mode, '5m');
  assert.equal(cfg.recommendedMode, '1h');
  assert.equal(cfg.supports1h, true);
});

test('prompt cache config respects explicit disable and settings precedence', () => {
  const cfg = inspectPromptCacheConfig({
    env: {
      DISABLE_PROMPT_CACHING: '1',
      ENABLE_PROMPT_CACHING_1H: '1',
    },
  }, { ENABLE_PROMPT_CACHING_1H: '0' }, { activeModelId: 'claude-sonnet-4-6' });
  assert.equal(cfg.mode, 'off');
  assert.equal(cfg.disablePromptCaching.source, 'settings.env');
});

test('applyPromptCacheMode mutates settings env predictably', () => {
  const settings = applyPromptCacheMode({ env: {} }, '1h');
  assert.equal(settings.env.DISABLE_PROMPT_CACHING, '0');
  assert.equal(settings.env.ENABLE_PROMPT_CACHING_1H, '1');
  const off = applyPromptCacheMode({ env: settings.env }, 'off');
  assert.equal(off.env.DISABLE_PROMPT_CACHING, '1');
  assert.equal(off.env.ENABLE_PROMPT_CACHING_1H, undefined);
});

test('resolveConfiguredModel maps aliases to pinned defaults', () => {
  const model = resolveConfiguredModel({
    model: 'sonnet',
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6[1m]' },
  });
  assert.equal(model, 'claude-sonnet-4-6[1m]');
});

test('1h cache support and context window helpers follow current model rules', () => {
  assert.equal(supportsOneHourPromptCache('claude-haiku-4-5@20251001'), true);
  assert.equal(supportsOneHourPromptCache('claude-3-7-sonnet'), false);
  assert.equal(contextWindowForModel('claude-sonnet-4-6[1m]'), 1_000_000);
  assert.equal(contextWindowForModel('claude-haiku-4-5@20251001'), 200_000);
  assert.equal(normalizePromptCacheMode('auto'), '5m');
});
