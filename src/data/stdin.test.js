import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTotalTokens, getContextPercent, getBufferedPercent,
  getModelName, isBedrockModelId, getProviderLabel, getUsageFromStdin,
} from './stdin.js';

describe('getTotalTokens', () => {
  it('sums all token fields', () => {
    const stdin = {
      context_window: {
        current_usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 },
      },
    };
    assert.equal(getTotalTokens(stdin), 600);
  });

  it('handles missing fields', () => {
    assert.equal(getTotalTokens({}), 0);
    assert.equal(getTotalTokens({ context_window: {} }), 0);
    assert.equal(getTotalTokens({ context_window: { current_usage: null } }), 0);
  });
});

describe('getContextPercent', () => {
  it('uses native percentage when available', () => {
    const stdin = { context_window: { used_percentage: 48, context_window_size: 200000 } };
    assert.equal(getContextPercent(stdin), 48);
  });

  it('falls back to manual calculation', () => {
    const stdin = {
      context_window: {
        context_window_size: 100000,
        current_usage: { input_tokens: 25000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    assert.equal(getContextPercent(stdin), 25);
  });

  it('returns 0 for empty input', () => {
    assert.equal(getContextPercent({}), 0);
  });

  it('clamps to 100', () => {
    const stdin = { context_window: { used_percentage: 150 } };
    assert.equal(getContextPercent(stdin), 100);
  });
});

describe('getModelName', () => {
  it('returns display_name when available', () => {
    assert.equal(getModelName({ model: { display_name: 'Opus 4.6' } }), 'Opus 4.6');
  });

  it('returns model id as fallback', () => {
    assert.equal(getModelName({ model: { id: 'claude-opus-4-6' } }), 'claude-opus-4-6');
  });

  it('normalizes Bedrock model IDs', () => {
    assert.equal(getModelName({ model: { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } }), 'Claude Sonnet 3.5');
  });

  it('returns Unknown for empty input', () => {
    assert.equal(getModelName({}), 'Unknown');
  });
});

describe('isBedrockModelId', () => {
  it('detects Bedrock IDs', () => {
    assert.equal(isBedrockModelId('anthropic.claude-3-5-sonnet-20241022-v2:0'), true);
    assert.equal(isBedrockModelId('claude-opus-4-6'), false);
    assert.equal(isBedrockModelId(undefined), false);
  });
});

describe('getProviderLabel', () => {
  it('returns Bedrock for Bedrock models', () => {
    assert.equal(getProviderLabel({ model: { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } }), 'Bedrock');
  });
  it('returns null for standard models', () => {
    assert.equal(getProviderLabel({ model: { id: 'claude-opus-4-6' } }), null);
  });
});

describe('getUsageFromStdin', () => {
  it('parses rate limits', () => {
    const stdin = {
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: 1743612000 },
        seven_day: { used_percentage: 38, resets_at: 1744000000 },
      },
    };
    const usage = getUsageFromStdin(stdin);
    assert.equal(usage.fiveHour, 62);
    assert.equal(usage.sevenDay, 38);
    assert.ok(usage.fiveHourResetAt instanceof Date);
    assert.ok(usage.sevenDayResetAt instanceof Date);
  });

  it('returns null when no rate limits', () => {
    assert.equal(getUsageFromStdin({}), null);
    assert.equal(getUsageFromStdin({ rate_limits: null }), null);
  });

  it('handles partial data', () => {
    const stdin = {
      rate_limits: { five_hour: { used_percentage: 50 }, seven_day: null },
    };
    const usage = getUsageFromStdin(stdin);
    assert.equal(usage.fiveHour, 50);
    assert.equal(usage.sevenDay, null);
  });
});
