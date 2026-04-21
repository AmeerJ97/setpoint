/**
 * Guard status reader — parses /tmp/claude-quality-guard.log
 * and checks if the guard systemd service is running.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GUARD_LOG_FILE, PLUGIN_DIR } from '../data/paths.js';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} GuardStatus
 * @property {boolean} running
 * @property {number} activationsToday
 * @property {number} activationsLastHour
 * @property {number} activationsPerHour
 * @property {Date|null} lastActivation
 * @property {string|null} lastFlag
 * @property {Record<string, number>} flagCounts - per-flag activation counts today
 * @property {string|null} topFlag - most frequently reverted flag today
 * @property {number} skippedCount - number of skipped override categories
 * @property {string[]} skippedCategories - names of skipped categories (subset of defaults.guard.categories)
 * @property {Record<string, string>} skipReasons - optional single-line reason per skipped category, keyed by category name
 */

/**
 * @returns {Promise<GuardStatus>}
 */
export async function readGuardStatus() {
  const running = await isGuardRunning();
  const { activationsToday, activationsLastHour, activationsPerHour, lastActivation, lastFlag, flagCounts, topFlag } = parseGuardLog();
  const skippedCategories = listSkippedCategories();
  const skippedCount = skippedCategories.length;
  const skipReasons = readSkipReasons(skippedCategories);

  return {
    running, activationsToday, activationsLastHour, activationsPerHour,
    lastActivation, lastFlag, flagCounts, topFlag, skippedCount,
    skippedCategories, skipReasons,
  };
}

/**
 * Read optional `<cat>.skip.reason` sibling files for each skipped category.
 * The reason is a single-line tag (e.g. `opus_4_7_incompatible`) that makes
 * the skip state self-documenting on `setpoint guard status`.
 * @param {string[]} cats
 * @returns {Record<string, string>}
 */
function readSkipReasons(cats) {
  const configDir = `${PLUGIN_DIR}/guard-config`;
  const out = {};
  for (const cat of cats) {
    try {
      const p = `${configDir}/${cat}.skip.reason`;
      if (!existsSync(p)) continue;
      const txt = readFileSync(p, 'utf8').split('\n')[0].trim();
      if (txt) out[cat] = txt;
    } catch { /* ignore malformed / unreadable reasons */ }
  }
  return out;
}

/**
 * @returns {Promise<boolean>}
 */
async function isGuardRunning() {
  try {
    const { stdout } = await execFileAsync(
      'systemctl', ['--user', 'is-active', 'claude-quality-guard'],
      { timeout: 1000, encoding: 'utf8' }
    );
    return stdout.trim() === 'active';
  } catch {
    // Also check for process directly
    try {
      const { stdout } = await execFileAsync(
        'pgrep', ['-f', 'claude-quality-guard'],
        { timeout: 1000, encoding: 'utf8' }
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}

/**
 * Read the names of skipped categories from `<plugin>/guard-config/*.skip`.
 * Returns the bare category name (e.g. `brevity`), not the .skip filename.
 * @returns {string[]}
 */
function listSkippedCategories() {
  const configDir = `${PLUGIN_DIR}/guard-config`;
  try {
    if (!existsSync(configDir)) return [];
    return readdirSync(configDir)
      .filter(f => f.endsWith('.skip'))
      .map(f => f.replace(/\.skip$/, ''));
  } catch {
    return [];
  }
}

/**
 * Parse the guard log file.
 * New format: 2026-04-19T12:34:56-07:00 Re-applied: flag1,flag2 (N overrides)
 * Legacy format: [HH:MM:SS] Re-applied: flag1,flag2 (N overrides)
 */
function parseGuardLog() {
  const result = {
    activationsToday: 0,
    activationsLastHour: 0,
    activationsPerHour: 0,
    lastActivation: null,
    lastFlag: null,
    flagCounts: {},
    topFlag: null,
  };

  if (!existsSync(GUARD_LOG_FILE)) return result;

  const nowMs = Date.now();
  const lastHourCutoffMs = nowMs - 60 * 60 * 1000;
  const todayLocal = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

  try {
    const content = readFileSync(GUARD_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      if (!line.includes('Re-applied')) continue;

      const activationDate = parseActivationTimestamp(line, todayLocal);
      if (!activationDate) continue;

      const tsMs = activationDate.getTime();
      if (!Number.isFinite(tsMs)) continue;

      const isToday = activationDate.toLocaleDateString('en-CA') === todayLocal;
      if (isToday) result.activationsToday++;
      if (tsMs >= lastHourCutoffMs) result.activationsLastHour++;

      if (!result.lastActivation || tsMs > result.lastActivation.getTime()) {
        result.lastActivation = activationDate;
      }

      const flags = parseFlagsFromLine(line);
      if (flags.length > 0) {
        result.lastFlag = flags[0]?.replace('tengu_', '') ?? null;
      }

      if (isToday) {
        for (const flag of flags) {
          const clean = flag.replace('tengu_', '');
          result.flagCounts[clean] = (result.flagCounts[clean] ?? 0) + 1;
        }
      }
    }

    const entries = Object.entries(result.flagCounts);
    if (entries.length > 0) {
      entries.sort((a, b) => b[1] - a[1]);
      result.topFlag = entries[0][0];
    }
  } catch { /* ignore */ }

  result.activationsPerHour = result.activationsLastHour;
  return result;
}

function parseActivationTimestamp(line, todayLocal) {
  // New format written by guard: 2026-04-19T12:34:56-07:00 Re-applied: ...
  const isoMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Legacy format: [HH:MM:SS] Re-applied: ...
  const timeMatch = line.match(/\[(\d{2}:\d{2}:\d{2})\]/);
  if (timeMatch) {
    const d = new Date(`${todayLocal}T${timeMatch[1]}`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function parseFlagsFromLine(line) {
  const m = line.match(/Re-applied: (.+?) \(\d+ overrides\)/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}
