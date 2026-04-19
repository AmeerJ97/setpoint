import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from '../../data/paths.js';

export function checkDiskUsage() {
  const issues = [];
  try {
    let totalSize = 0;
    const breakdown = {};
    for (const entry of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      const entryPath = join(CLAUDE_DIR, entry.name);
      const size = entry.isDirectory() ? getDirSize(entryPath) : (statSync(entryPath).size || 0);
      totalSize += size;
      if (size > 1024 * 1024) {
        breakdown[entry.name] = `${(size / 1024 / 1024).toFixed(1)}MB`;
      }
    }
    issues.push({
      severity: 'info',
      check: 'disk-usage',
      message: `~/.claude/ total: ${(totalSize / 1024 / 1024).toFixed(1)}MB`,
      breakdown,
    });
  } catch { /* ignore */ }
  return issues;
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const p = join(dirPath, entry.name);
      if (entry.isDirectory()) size += getDirSize(p);
      else try { size += statSync(p).size; } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return size;
}
