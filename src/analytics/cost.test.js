import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calculateCost, resolvePricing, costWeightedBurnRate, ewmaBurnRate, perTokenWeights } from './cost.js';
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

test('perTokenWeights returns USD-per-token weights for the named model', () => {
  const w = perTokenWeights('claude-opus-4-7');
  // Opus 4.7: $5/MTok input, $25/MTok output, $0.50/MTok read, $6.25/MTok 5m write
  assert.equal(w.input,       5    / 1_000_000);
  assert.equal(w.output,      25   / 1_000_000);
  assert.equal(w.cacheRead,   0.50 / 1_000_000);
  assert.equal(w.cacheCreate, 6.25 / 1_000_000);
});

test('costWeightedBurnRate equals output/duration when only output tokens present', () => {
  const burn = costWeightedBurnRate({
    totalInput: 0, totalOutput: 1000, totalCacheCreate: 0, totalCacheRead: 0,
    durationMin: 10,
  }, 'claude-opus-4-7');
  // 1000 output tokens / 10 min = 100 t/m exactly
  assert.equal(burn, 100);
});

test('costWeightedBurnRate inflates a cache-heavy turn (Phase 1.2 fix)', () => {
  // Old formula would say 5 t/m (50/10). New formula counts the 100K cache_read.
  // 100K reads * $0.50/MTok = $0.05; expressed as output-equiv at $25/MTok
  // = 0.05 / 25 * 1M = 2000 tokens equivalent. Plus 50 raw output → 2050 total.
  // Over 10 min → 205 t/m. Old formula would have shown 5.
  const burn = costWeightedBurnRate({
    totalInput: 0, totalOutput: 50, totalCacheCreate: 0, totalCacheRead: 100_000,
    durationMin: 10,
  }, 'claude-opus-4-7');
  assert.ok(burn > 100, `expected cache-heavy burn > 100 t/m, got ${burn}`);
});

test('costWeightedBurnRate returns 0 when durationMin is 0', () => {
  const burn = costWeightedBurnRate({ totalOutput: 5000, durationMin: 0 }, 'claude-opus-4-7');
  assert.equal(burn, 0);
});

test('ewmaBurnRate returns 0 for empty series', () => {
  assert.equal(ewmaBurnRate([], 10), 0);
  assert.equal(ewmaBurnRate(null, 10), 0);
});

test('ewmaBurnRate biases toward recent values with α=0.2', () => {
  // [100, 100, 100, 100, 1000] over 5 turns / 10 min.
  // EWMA progression: 100 → 100 → 100 → 100 → 100 + 0.2*(1000-100)=280
  // turnsPerMin = 5/10 = 0.5; smoothed = 280 * 0.5 = 140
  const smoothed = ewmaBurnRate([100, 100, 100, 100, 1000], 10);
  assert.equal(smoothed, 140);
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
