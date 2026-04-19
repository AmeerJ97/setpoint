import { readdirSync } from 'node:fs';
import { CLAUDE_DIR } from '../../data/paths.js';

const KNOWN_ENTRIES = new Set([
  'CLAUDE.md', 'AGENTS.md', 'RTK.md',
  'rules', 'settings.json', 'settings.local.json',
  'projects', 'sessions', 'plugins', 'agents', 'commands',
  'todos', 'memory', 'statsig', 'plans', 'keybindings.json',
  'credentials.json', 'beads',
  'hooks', 'cache', 'chrome', 'debug', 'ide', 'skills', 'tasks',
  'mcp-configs', 'paste-cache', 'session-env', 'shell-snapshots',
  'file-history', 'backups', 'history.jsonl',
]);

const KNOWN_PREFIXES = ['vercel-plugin-'];

export function checkOrphanFiles() {
  const issues = [];
  try {
    for (const entry of readdirSync(CLAUDE_DIR)) {
      if (!KNOWN_ENTRIES.has(entry) && !entry.startsWith('.') &&
          !KNOWN_PREFIXES.some(p => entry.startsWith(p))) {
        issues.push({
          severity: 'info',
          check: 'orphan-files',
          message: `Unexpected entry in ~/.claude/: ${entry}`,
        });
      }
    }
  } catch { /* ignore */ }
  return issues;
}
