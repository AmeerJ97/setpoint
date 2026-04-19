import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calculateCost, resolvePricing } from './cost.js';
import { resetDefaultsCache } from '../data/defaults.js';

beforeEach(() => {
  delete process.env.CLAUDE_HUD_PRICING_FILE;
  delete process.env.CLAUDE_HUD_DEFAULTS_FILE;
  resetDefaultsCache();
});

test('resolvePricing matches exact model IDs from defaults.json', () => {
  const haiku = resolvePricing('claude-haiku-4-5');
  const sonnet = resolvePricing('claude-sonnet-4-6');
  const opus = resolvePricing('claude-opus-4-7');
  // Sanity: output is monotonically more expensive going haiku → sonnet → opus
  assert.ok(haiku.output < sonnet.output, 'haiku output < sonnet output');
  assert.ok(sonnet.output < opus.output, 'sonnet output < opus output');
});

test('resolvePricing falls back to defaultModel for unknown names', () => {
  const unknown = resolvePricing('some-future-model-999');
  const defaultPricing = resolvePricing();
  assert.deepEqual(unknown, defaultPricing);
});

test('resolvePricing matches display-name variants (case + spaces)', () => {
  const a = resolvePricing('Opus 4.7');
  const b = resolvePricing('opus 4.7');
  const c = resolvePricing('claude-opus-4-7');
  // a and b go through lowercase+dash normalization; substring match kicks in
  assert.equal(a.output, c.output);
  assert.equal(b.output, c.output);
});

test('calculateCost respects model pricing', () => {
  const stats = { totalInput: 1_000_000, totalOutput: 1_000_000 };
  const opus = calculateCost(stats, 'claude-opus-4-7');
  const haiku = calculateCost(stats, 'claude-haiku-4-5');
  assert.ok(opus > haiku, 'opus must cost more than haiku for identical usage');
});

test('calculateCost with no model uses defaultModel', () => {
  const stats = { totalInput: 1_000_000, totalOutput: 1_000_000 };
  const defaulted = calculateCost(stats);
  const explicit = calculateCost(stats, 'claude-opus-4-7');
  assert.equal(defaulted, explicit);
});

test('calculateCost returns 0 for null stats', () => {
  assert.equal(calculateCost(null), 0);
  assert.equal(calculateCost(undefined), 0);
});

test('CLAUDE_HUD_PRICING_FILE overrides pricing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-hud-pricing-'));
  const file = join(dir, 'pricing.json');
  writeFileSync(file, JSON.stringify({
    pricing: {
      defaultModel: 'test-model',
      models: {
        'test-model': { input: 1000, output: 1000, cacheCreate: 1000, cacheRead: 1000 },
      },
    },
  }));

  process.env.CLAUDE_HUD_PRICING_FILE = file;
  resetDefaultsCache();

  try {
    const cost = calculateCost({ totalInput: 1_000_000 }, 'test-model');
    // 1M tokens at $1000/1M = $1000
    assert.equal(cost, 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
