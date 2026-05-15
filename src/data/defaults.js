/**
 * Loader for the project-level defaults at config/defaults.json.
 *
 * Precedence:
 *   1. CLAUDE_OPS_PRICING_FILE (absolute path — overrides pricing only)
 *   2. CLAUDE_OPS_DEFAULTS_FILE (absolute path — overrides the whole blob)
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

  const override = process.env.CLAUDE_OPS_DEFAULTS_FILE?.trim();
  const base = (override && readJsonSafe(override)) || readJsonSafe(REPO_DEFAULTS) || {};

  // Pricing-only override (common case: swap model prices without rebuilding)
  const pricingOverride = process.env.CLAUDE_OPS_PRICING_FILE?.trim();
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
 * @returns {{ defaultModel: string, dataResidencyMultiplier?: number, models: Record<string, { input:number, output:number, cacheCreate5m:number, cacheCreate1h:number, cacheRead:number }> }}
 */
export function getPricing() {
  const d = loadDefaults();
  return d.pricing ?? { defaultModel: 'claude-opus-4-7', models: {} };
}

/**
 * Get rates tuning block.
 * @returns {{ activeHoursPerDay: number, classifyLevel: { critical: number, tight: number, watch: number }, peakHours: { enabled: boolean, timezone: string, startHour: number, endHour: number, multiplier: number } }}
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
    peakHours: {
      enabled:    d.rates?.peakHours?.enabled    ?? false,
      timezone:   d.rates?.peakHours?.timezone   ?? 'America/Los_Angeles',
      startHour:  d.rates?.peakHours?.startHour  ?? 5,
      endHour:    d.rates?.peakHours?.endHour    ?? 11,
      multiplier: d.rates?.peakHours?.multiplier ?? 1.5,
    },
  };
}

/**
 * Get telemetry maturity tuning.
 * @returns {{ apiRefs: { minSamples: number, minDistinctSessions: number, minOldestAgeMinutes: number }, vertexSynthetic: { minSamples: number, minDistinctSessions: number, minOldestAgeMinutes: number }, vertexApi: { maxSnapshotAgeMinutes: number } }}
 */
export function getTelemetryTuning() {
  const d = loadDefaults();
  return {
    apiRefs: {
      minSamples: d.telemetry?.apiRefs?.minSamples ?? 3,
      minDistinctSessions: d.telemetry?.apiRefs?.minDistinctSessions ?? 2,
      minOldestAgeMinutes: d.telemetry?.apiRefs?.minOldestAgeMinutes ?? 30,
    },
    vertexSynthetic: {
      minSamples: d.telemetry?.vertexSynthetic?.minSamples ?? 3,
      minDistinctSessions: d.telemetry?.vertexSynthetic?.minDistinctSessions ?? 2,
      minOldestAgeMinutes: d.telemetry?.vertexSynthetic?.minOldestAgeMinutes ?? 30,
    },
    vertexApi: {
      maxSnapshotAgeMinutes: d.telemetry?.vertexApi?.maxSnapshotAgeMinutes ?? 20,
    },
  };
}

/**
 * Get hook behavior defaults.
 * @returns {{ mode: 'advisory'|'blocking', preCompactSnapshots: boolean }}
 */
export function getHookDefaults() {
  const d = loadDefaults();
  return {
    mode: d.hooks?.mode === 'blocking' ? 'blocking' : 'advisory',
    preCompactSnapshots: d.hooks?.preCompactSnapshots === true,
  };
}

/**
 * Get experimental-tool gates.
 * @returns {{ scan: boolean, consolidate: boolean }}
 */
export function getExperimentalDefaults() {
  const d = loadDefaults();
  return {
    scan: d.experimental?.scan === true,
    consolidate: d.experimental?.consolidate === true,
  };
}
