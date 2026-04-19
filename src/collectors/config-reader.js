/**
 * Config reader — counts CLAUDE.md files, rules, MCPs, and hooks.
 * Ported from old HUD config-reader.ts.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getClaudeConfigDir, CLAUDE_JSON_PATH } from '../data/paths.js';

/**
 * @typedef {object} ConfigCounts
 * @property {number} claudeMdCount
 * @property {number} rulesCount
 * @property {number} mcpCount
 * @property {number} hooksCount
 */

/**
 * @param {string} filePath
 * @returns {Set<string>}
 */
function getMcpServerNames(filePath) {
  if (!existsSync(filePath)) return new Set();
  try {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    if (config.mcpServers && typeof config.mcpServers === 'object') {
      return new Set(Object.keys(config.mcpServers));
    }
  } catch { /* ignore */ }
  return new Set();
}

/**
 * @param {string} filePath
 * @param {string} key
 * @returns {Set<string>}
 */
function getDisabledMcpServers(filePath, key) {
  if (!existsSync(filePath)) return new Set();
  try {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    if (Array.isArray(config[key])) {
      return new Set(config[key].filter(s => typeof s === 'string'));
    }
  } catch { /* ignore */ }
  return new Set();
}

/**
 * @param {string} filePath
 * @returns {number}
 */
function countHooksInFile(filePath) {
  if (!existsSync(filePath)) return 0;
  try {
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    if (config.hooks && typeof config.hooks === 'object') {
      return Object.keys(config.hooks).length;
    }
  } catch { /* ignore */ }
  return 0;
}

/**
 * @param {string} rulesDir
 * @returns {number}
 */
function countRulesInDir(rulesDir) {
  if (!existsSync(rulesDir)) return 0;
  let count = 0;
  try {
    const entries = readdirSync(rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(rulesDir, entry.name);
      if (entry.isDirectory()) {
        count += countRulesInDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}

/**
 * Count all config items across user and project scopes.
 * @param {string} [cwd]
 * @returns {Promise<ConfigCounts>}
 */
export async function countConfigs(cwd) {
  let claudeMdCount = 0;
  let rulesCount = 0;
  let hooksCount = 0;

  const home = homedir();
  const claudeDir = getClaudeConfigDir(home);
  const userMcpServers = new Set();
  const projectMcpServers = new Set();

  // === USER SCOPE ===
  if (existsSync(join(claudeDir, 'CLAUDE.md'))) claudeMdCount++;
  rulesCount += countRulesInDir(join(claudeDir, 'rules'));

  const userSettings = join(claudeDir, 'settings.json');
  for (const name of getMcpServerNames(userSettings)) userMcpServers.add(name);
  hooksCount += countHooksInFile(userSettings);

  for (const name of getMcpServerNames(CLAUDE_JSON_PATH)) userMcpServers.add(name);

  const disabledUserMcps = getDisabledMcpServers(CLAUDE_JSON_PATH, 'disabledMcpServers');
  for (const name of disabledUserMcps) userMcpServers.delete(name);

  // === PROJECT SCOPE ===
  if (cwd) {
    if (existsSync(join(cwd, 'CLAUDE.md'))) claudeMdCount++;
    if (existsSync(join(cwd, 'CLAUDE.local.md'))) claudeMdCount++;
    if (existsSync(join(cwd, '.claude', 'CLAUDE.md'))) claudeMdCount++;

    rulesCount += countRulesInDir(join(cwd, '.claude', 'rules'));

    const mcpJsonServers = getMcpServerNames(join(cwd, '.mcp.json'));
    const projectSettings = join(cwd, '.claude', 'settings.json');
    for (const name of getMcpServerNames(projectSettings)) projectMcpServers.add(name);
    hooksCount += countHooksInFile(projectSettings);

    const localSettings = join(cwd, '.claude', 'settings.local.json');
    for (const name of getMcpServerNames(localSettings)) projectMcpServers.add(name);
    hooksCount += countHooksInFile(localSettings);

    const disabledMcpJson = getDisabledMcpServers(localSettings, 'disabledMcpjsonServers');
    for (const name of disabledMcpJson) mcpJsonServers.delete(name);
    for (const name of mcpJsonServers) projectMcpServers.add(name);
  }

  const mcpCount = userMcpServers.size + projectMcpServers.size;
  return { claudeMdCount, rulesCount, mcpCount, hooksCount };
}
