/**
 * Loader for the project-level defaults at config/defaults.json.
 *
 * Precedence:
 *   1. CLAUDE_HUD_PRICING_FILE (absolute path — overrides pricing only)
 *   2. CLAUDE_HUD_DEFAULTS_FILE (absolute path — overrides the whole blob)
 *   3. <repo>/config/defaults.json (checked in)
 *
 * Cached after first successful read. Tests can call resetDefaultsCache().
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// src/data/defaults.js  →  <repo>/config/defaults.json
const REPO_DEFAULTS = join(MODULE_DIR, '..', '..', 'config', 'defaults.json');

let cached = null;

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return null; }
}

/**
 * Load the full defaults blob. Always returns an object (empty if unreadable).
 * @returns {object}
 */
export function loadDefaults() {
  if (cached) return cached;

  const override = process.env.CLAUDE_HUD_DEFAULTS_FILE?.trim();
  const base = (override && readJsonSafe(override)) || readJsonSafe(REPO_DEFAULTS) || {};

  // Pricing-only override (common case: swap model prices without rebuilding)
  const pricingOverride = process.env.CLAUDE_HUD_PRICING_FILE?.trim();
  if (pricingOverride) {
    const p = readJsonSafe(pricingOverride);
    if (p) base.pricing = p.pricing ?? p;
  }

  cached = base;
  return cached;
}

/**
 * Reset the cache. Test-only; not exported from the barrel.
 */
export function resetDefaultsCache() {
  cached = null;
}

/**
 * Get the pricing table and default model ID.
 * @returns {{ defaultModel: string, models: Record<string, { input:number, output:number, cacheCreate:number, cacheRead:number }> }}
 */
export function getPricing() {
  const d = loadDefaults();
  return d.pricing ?? { defaultModel: 'claude-opus-4-7', models: {} };
}

/**
 * Get rates tuning block.
 * @returns {{ activeHoursPerDay: number, classifyLevel: { critical: number, tight: number, watch: number } }}
 */
export function getRatesTuning() {
  const d = loadDefaults();
  return {
    activeHoursPerDay: d.rates?.activeHoursPerDay ?? 10,
    classifyLevel: {
      critical: d.rates?.classifyLevel?.critical ?? 90,
      tight:    d.rates?.classifyLevel?.tight    ?? 70,
      watch:    d.rates?.classifyLevel?.watch    ?? 50,
    },
  };
}
