import { readFileSync, existsSync } from 'node:fs';
import { CLAUDE_JSON_PATH } from './paths.js';

/**
 * Read and parse ~/.claude.json. Returns null on error.
 * @param {string} [configPath]
 * @returns {object|null}
 */
export function readClaudeConfig(configPath = CLAUDE_JSON_PATH) {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Get a cached GrowthBook feature value from ~/.claude.json.
 * @param {string} key - feature flag name
 * @param {string} [configPath]
 * @returns {*} the feature value, or undefined if not found
 */
export function getGrowthBookFeature(key, configPath = CLAUDE_JSON_PATH) {
  const config = readClaudeConfig(configPath);
  return config?.cachedGrowthBookFeatures?.[key];
}

/**
 * Check if tool result summarization is enabled (compression).
 * @param {string} [configPath]
 * @returns {boolean}
 */
export function isCompressionEnabled(configPath = CLAUDE_JSON_PATH) {
  return getGrowthBookFeature('tengu_summarize_tool_results', configPath) === true;
}
