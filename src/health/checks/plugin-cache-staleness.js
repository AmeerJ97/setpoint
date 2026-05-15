import { existsSync, readdirSync, statSync } from 'node:fs';
import { TOKEN_STATS_DIR, TOKEN_STATS_LATEST } from '../../data/paths.js';

const STALE_MS = 5 * 60_000;

export function checkPluginCacheStaleness(now = Date.now()) {
  const issues = [];
  const ages = [];
  collectAge(TOKEN_STATS_LATEST, ages, now);
  try {
    if (existsSync(TOKEN_STATS_DIR)) {
      for (const name of readdirSync(TOKEN_STATS_DIR)) {
        if (name.endsWith('.json')) collectAge(`${TOKEN_STATS_DIR}/${name}`, ages, now);
      }
    }
  } catch { /* ignore */ }

  if (ages.length === 0) {
    issues.push({ severity: 'info', check: 'plugin-cache-staleness', message: 'no token cache snapshots yet' });
    return issues;
  }

  const freshest = Math.min(...ages);
  const stale = freshest > STALE_MS;
  issues.push({
    severity: stale ? 'warning' : 'info',
    check: 'plugin-cache-staleness',
    message: `freshest token cache ${Math.round(freshest / 1000)}s old`,
  });
  return issues;
}

function collectAge(path, ages, now) {
  try {
    if (!existsSync(path)) return;
    ages.push(now - statSync(path).mtimeMs);
  } catch { /* ignore */ }
}
