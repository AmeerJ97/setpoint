/**
 * Background drain detector — catches Cowork, Chrome native hosts,
 * Desktop agent sessions, and any other processes consuming quota
 * without the user's knowledge.
 *
 * IMPORTANT: All process checks use non-blocking try/catch and short
 * timeouts. We must never kill or interfere with Desktop processes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * @returns {Array<{ triggered: boolean, message: string, severity: 'warn'|'critical' }>}
 */
export function checkBackgroundDrain() {
  const alerts = [];

  // 1. Cowork / CCD scheduled tasks — only a real drain when Claude
  //    Desktop is actually running. The config flag can linger from a
  //    past Desktop install long after the app is quit; firing on the
  //    flag alone is a false positive.
  try {
    const desktopConfig = JSON.parse(
      readFileSync(join(homedir(), '.config/Claude/claude_desktop_config.json'), 'utf8')
    );
    const prefs = desktopConfig.preferences || {};
    const desktopRunning = isClaudeDesktopRunning();

    // Downgraded from 'critical' to 'warn' on 2026-04-20: it was firing
    // on every render for users who always run Desktop, and monopolizing
    // the Advisor line. The info still matters, but the signal isn't
    // urgent enough to override a quota/projection recommendation.
    if (desktopRunning && prefs.coworkScheduledTasksEnabled === true) {
      alerts.push({
        triggered: true,
        message: 'cowork on — bg quota drain',
        severity: 'warn',
      });
    }
    if (desktopRunning && prefs.ccdScheduledTasksEnabled === true) {
      alerts.push({
        triggered: true,
        message: 'ccd on — bg quota drain',
        severity: 'warn',
      });
    }
  } catch { /* no desktop config — fine */ }

  // 2. Check for chrome-native-host processes (read-only pgrep, short timeout)
  try {
    const out = execFileSync('pgrep', ['-c', 'chrome-native-host'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const count = parseInt(out.trim(), 10);
    if (count > 0) {
      alerts.push({
        triggered: true,
        message: `${count} chrome-host — bg drain`,
        severity: 'warn',
      });
    }
  } catch {
    // pgrep exits non-zero when no processes found — that's the good case
  }

  // 3. Check for active Desktop local-agent sessions (file mtime only — no process interaction)
  try {
    const sessDir = join(homedir(), '.config/Claude/local-agent-mode-sessions');
    if (existsSync(sessDir)) {
      const cutoff = Date.now() - 3600000; // 1 hour
      const recent = [];
      findRecentJsonl(sessDir, cutoff, recent, 0);
      if (recent.length > 0) {
        alerts.push({
          triggered: true,
          message: `${recent.length} desktop agents — bg drain`,
          severity: 'warn',
        });
      }
    }
  } catch { /* ignore */ }

  // NOTE: We intentionally do NOT check for cowork-vm-service process.
  // It's a normal part of Claude Desktop and killing/checking it can
  // interfere with the Desktop app. The config flag check above is sufficient.

  return alerts;
}

/**
 * Is Claude Desktop actually running? Non-blocking pgrep; returns false
 * if pgrep exits non-zero (no match) or anything goes wrong.
 */
function isClaudeDesktopRunning() {
  try {
    execFileSync('pgrep', ['-f', 'claude-desktop|Claude Desktop|claude_desktop|cowork-vm|ccd-vm'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch { return false; }
}

function findRecentJsonl(dir, cutoff, results, depth) {
  if (depth > 5) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        findRecentJsonl(full, cutoff, results, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const stat = statSync(full);
          if (stat.mtimeMs > cutoff) results.push(full);
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
}
