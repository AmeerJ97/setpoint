import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECTS_DIR } from '../../data/paths.js';

const BLOAT_THRESHOLD = 50 * 1024 * 1024; // 50MB

export function checkSessionBloat() {
  const issues = [];
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const projDir = join(PROJECTS_DIR, proj);
      let totalSize = 0;
      try {
        for (const f of readdirSync(projDir).filter(f => f.endsWith('.jsonl'))) {
          try { totalSize += statSync(join(projDir, f)).size; } catch { /* skip */ }
        }
      } catch { continue; }
      if (totalSize > BLOAT_THRESHOLD) {
        issues.push({
          severity: 'warning',
          check: 'session-bloat',
          message: `Project ${proj}: ${(totalSize / 1024 / 1024).toFixed(1)}MB session files`,
        });
      }
    }
  } catch { /* PROJECTS_DIR missing */ }
  return issues;
}
