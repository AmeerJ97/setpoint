import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CLAUDE_JSON_PATH, PLUGIN_DIR } from '../../data/paths.js';

const SNAPSHOT_FILE = join(PLUGIN_DIR, 'config-snapshot.json');

export function checkConfigDrift() {
  const issues = [];
  if (!existsSync(CLAUDE_JSON_PATH)) return issues;

  try {
    const current = readFileSync(CLAUDE_JSON_PATH, 'utf8');
    const currentHash = createHash('sha256').update(current).digest('hex');

    if (existsSync(SNAPSHOT_FILE)) {
      const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
      if (snapshot.hash !== currentHash) {
        issues.push({
          severity: 'info',
          check: 'config-drift',
          message: `~/.claude.json changed since last audit`,
        });
      }
    }

    mkdirSync(PLUGIN_DIR, { recursive: true });
    writeFileSync(SNAPSHOT_FILE, JSON.stringify({ hash: currentHash, ts: new Date().toISOString() }));
  } catch { /* ignore */ }
  return issues;
}
