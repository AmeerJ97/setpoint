import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR, TOKEN_STATS_DIR } from '../../data/paths.js';
import { readJson } from '../../data/jsonl.js';

export function checkMcpAudit() {
  const configured = configuredMcpNames();
  const used = usedMcpNames();
  const unused = configured.filter(name => !used.includes(name));
  const issues = [{
    severity: 'info',
    check: 'mcp-audit',
    message: `MCP configured:${configured.length} used:${used.length}`,
    configured,
    used,
  }];
  if (configured.length > 0 && used.length === 0) {
    issues.push({
      severity: 'info',
      check: 'mcp-audit',
      message: 'MCP servers configured but no recent usage found in token cache',
      unused,
    });
  }
  return issues;
}

function configuredMcpNames() {
  const names = new Set();
  for (const file of [
    join(CLAUDE_DIR, 'settings.json'),
    join(CLAUDE_DIR, 'settings.local.json'),
    join(CLAUDE_DIR, '.mcp.json'),
  ]) {
    try {
      if (!existsSync(file)) continue;
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const key of Object.keys(data.mcpServers ?? {})) names.add(key);
    } catch { /* ignore */ }
  }
  return [...names].sort();
}

function usedMcpNames() {
  const names = new Set();
  try {
    if (!existsSync(TOKEN_STATS_DIR)) return [];
    for (const file of readdirJson(TOKEN_STATS_DIR)) {
      const data = readJson(file);
      for (const key of Object.keys(data?.mcps ?? {})) names.add(key);
    }
  } catch { /* ignore */ }
  return [...names].sort();
}

function readdirJson(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => join(dir, name));
}
