/**
 * Configurable anomaly thresholds.
 * Loads from config/defaults.json, with environment variable overrides.
 *
 * Environment variables:
 *   CLAUDE_HUD_RE_WARN - R:E ratio warning threshold (default: 2.0)
 *   CLAUDE_HUD_RE_CRITICAL - R:E ratio critical threshold (default: 1.0)
 *   CLAUDE_HUD_TOKEN_SPIKE - Token spike threshold (default: 50000)
 *   CLAUDE_HUD_MAX_SPAWNS_HR - Max agent spawns per hour (default: 50)
 *   CLAUDE_HUD_MAX_COMPACTIONS - Max compactions per session (default: 5)
 *   CLAUDE_HUD_CONTEXT_WARN - Context % warning threshold (default: 70)
 *   CLAUDE_HUD_CONTEXT_CRITICAL - Context % critical threshold (default: 85)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '../../config/defaults.json');

let configCache = null;

/**
 * Load config from defaults.json.
 * @returns {object}
 */
function loadConfig() {
  if (configCache) return configCache;

  try {
    if (existsSync(CONFIG_PATH)) {
      configCache = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch { /* use defaults */ }

  configCache = configCache ?? {};
  return configCache;
}

/**
 * Get a threshold value with env override.
 * @param {string} envKey
 * @param {number} defaultValue
 * @returns {number}
 */
function getThreshold(envKey, defaultValue) {
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const parsed = parseFloat(envVal);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

function getIntThreshold(envKey, defaultValue) {
  const envVal = process.env[envKey];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return defaultValue;
}

// Export configurable thresholds
export const THRESHOLDS = {
  // Read:Edit ratio
  RE_RATIO_HEALTHY: getThreshold('CLAUDE_HUD_RE_HEALTHY', 3.0),
  RE_RATIO_WARN: getThreshold('CLAUDE_HUD_RE_WARN', 2.0),
  RE_RATIO_CRITICAL: getThreshold('CLAUDE_HUD_RE_CRITICAL', 1.0),
  RE_MIN_EDITS: getIntThreshold('CLAUDE_HUD_RE_MIN_EDITS', 3),

  // Token spike
  TOKEN_SPIKE: getIntThreshold('CLAUDE_HUD_TOKEN_SPIKE', 50000),

  // Agent spawns
  MAX_SPAWNS_PER_HOUR: getIntThreshold('CLAUDE_HUD_MAX_SPAWNS_HR', 50),

  // Context thrashing
  MAX_COMPACTIONS: getIntThreshold('CLAUDE_HUD_MAX_COMPACTIONS', 5),

  // Stale session
  MAX_HOURS_WITHOUT_COMPACTION: getIntThreshold('CLAUDE_HUD_MAX_STALE_HOURS', 4),

  // GrowthBook escalation (two-tier)
  GUARD_ACTIVATIONS_WARN: getThreshold('CLAUDE_HUD_GUARD_WARN_HR', 300),
  GUARD_ACTIVATIONS_CRITICAL: getThreshold('CLAUDE_HUD_GUARD_CRITICAL_HR', 500),

  // MCP failures
  MCP_FAILURE_STREAK: getThreshold('CLAUDE_HUD_MCP_FAILURE_STREAK', 3),

  // Context pressure (new)
  CONTEXT_WARN_PCT: getThreshold('CLAUDE_HUD_CONTEXT_WARN', 70),
  CONTEXT_CRITICAL_PCT: getThreshold('CLAUDE_HUD_CONTEXT_CRITICAL', 85),

  // Tool diversity (new) - minimum unique tools before alerting
  MIN_TOOL_DIVERSITY: getThreshold('CLAUDE_HUD_MIN_TOOL_DIVERSITY', 3),

  // Session efficiency (new) - minimum output tokens per 1000 input
  MIN_EFFICIENCY_RATIO: getThreshold('CLAUDE_HUD_MIN_EFFICIENCY', 0.1),
};

/**
 * Get all thresholds as object for display/debugging.
 * @returns {typeof THRESHOLDS}
 */
export function getThresholds() {
  return { ...THRESHOLDS };
}
