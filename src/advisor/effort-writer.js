/**
 * Effort auto-swap writer.
 *
 * Writes a new `effortLevel` into Claude Code settings atomically
 * with a timestamped backup, records the swap in
 * `~/.claude/plugins/claude-ops/effort-log.jsonl` (append-only,
 * rotated), and updates the last-swap state file the controller
 * reads on its next tick.
 *
 * Guarded by a sentinel file
 * (`~/.claude/plugins/claude-ops/auto-effort.enabled`) or the
 * `CLAUDE_OPS_AUTO_EFFORT=1` env var — otherwise every function here is
 * a no-op. Fresh installs stay conservative.
 *
 * Risk flag from the plan: writing settings.json mid-session is
 * empirically untested — Claude Code may cache the value in-memory.
 * If the swap doesn't propagate, the Advisor line's recommendation
 * is still the user-facing surface and a session restart picks it up.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { writeJsonAtomic, rotateJsonl } from '../data/jsonl.js';
import { getClaudeConfigDir, getClaudeJsonPath, PLUGIN_DIR } from '../data/paths.js';

const SETTINGS_PATH = join(getClaudeConfigDir(), 'settings.json');
const CLAUDE_JSON = getClaudeJsonPath();
const AUTO_EFFORT_SENTINEL = join(PLUGIN_DIR, 'auto-effort.enabled');
const EFFORT_LOG = join(PLUGIN_DIR, 'effort-log.jsonl');
const LAST_SWAP_FILE = join(PLUGIN_DIR, 'effort-last-swap.json');

const MAX_LOG_BYTES = 1 * 1024 * 1024;   // 1 MB before rotation
const KEEP_LAST_ENTRIES = 1000;

/**
 * @returns {boolean} true when auto-effort is user-enabled
 */
export function isAutoEffortEnabled() {
  if (process.env.CLAUDE_OPS_AUTO_EFFORT === '1') return true;
  return existsSync(AUTO_EFFORT_SENTINEL);
}

/**
 * Read the most recent swap bookkeeping entry. Returned shape
 * matches the controller's `lastSwap` input (or null when no
 * swap has happened yet, or the file is malformed).
 *
 * @returns {{ts: number, target: string, contextPct: number}|null}
 */
export function readLastSwap() {
  try {
    if (!existsSync(LAST_SWAP_FILE)) return null;
    const raw = readFileSync(LAST_SWAP_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Number.isFinite(data?.ts) || typeof data?.target !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Apply a swap. Idempotent in the trivial sense (no target => no-op).
 * Returns `{applied, reason}` so the caller can log / surface.
 *
 * @param {{target: string|null, reason: string, contextPct: number, sessionId?: string, current?: string}} swap
 * @returns {{applied: boolean, reason: string}}
 */
export function applySwap(swap) {
  const { target, reason, contextPct, sessionId, current } = swap;

  if (!target) return { applied: false, reason: 'no target' };
  if (!isAutoEffortEnabled()) return { applied: false, reason: 'auto-effort disabled' };
  if (target === 'max') return { applied: false, reason: 'max is session-only; not persisted' };

  // Update ~/.claude/settings.json (what Claude Ops detectEffort reads).
  try {
    writeSettingsEffort(target);
  } catch (err) {
    return { applied: false, reason: `settings.json write failed: ${err.message}` };
  }

  // Piggy-back on ~/.claude.json if the GrowthBook cache holds an
  // effort key — future-proof hook for whatever Claude Code reads
  // at the request level. Best-effort; never fail the swap.
  try { updateClaudeJsonEffort(target); } catch { /* non-critical */ }

  // Persist the last-swap record for the next controller tick.
  const record = { ts: Date.now(), target, contextPct, reason, sessionId: sessionId ?? null, previous: current ?? null };
  try { writeJsonAtomic(LAST_SWAP_FILE, record); } catch { /* ignore */ }

  // Append to the audit log with rotation.
  try {
    mkdirSync(dirname(EFFORT_LOG), { recursive: true });
    appendFileSync(EFFORT_LOG, JSON.stringify(record) + '\n');
    rotateJsonl(EFFORT_LOG, MAX_LOG_BYTES, KEEP_LAST_ENTRIES);
  } catch { /* non-critical */ }

  return { applied: true, reason };
}

/**
 * Return the N most recent swap records from the effort log,
 * newest first. Used by `claude-ops auto-effort status`.
 *
 * @param {number} [limit=10]
 * @returns {object[]}
 */
export function readRecentSwaps(limit = 10) {
  try {
    if (!existsSync(EFFORT_LOG)) return [];
    const lines = readFileSync(EFFORT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const out = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return out.reverse();
  } catch {
    return [];
  }
}

// ------ internal helpers ---------------------------------------------------

function writeSettingsEffort(target) {
  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    // One-time timestamped backup the first time we touch settings.json
    // in a given day; avoids backup-on-every-swap flood.
    const dayStamp = new Date().toISOString().slice(0, 10);
    const backup = `${SETTINGS_PATH}.claude-ops.${dayStamp}.bak`;
    if (!existsSync(backup)) {
      try { copyFileSync(SETTINGS_PATH, backup); } catch { /* ignore */ }
    }
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  }
  settings.effortLevel = target;
  writeJsonAtomic(SETTINGS_PATH, settings);
}

function updateClaudeJsonEffort(target) {
  if (!existsSync(CLAUDE_JSON)) return;
  const raw = readFileSync(CLAUDE_JSON, 'utf8');
  const data = JSON.parse(raw);
  // Only touch if a cached effort-like key already exists; otherwise
  // don't pollute the GrowthBook cache.
  if (data?.cachedStatsigExperiments?.tengu_output_config) {
    data.cachedStatsigExperiments.tengu_output_config.effort = target;
  } else if (typeof data?.output_config === 'object' && data.output_config !== null) {
    data.output_config.effort = target;
  } else {
    return;
  }
  writeJsonAtomic(CLAUDE_JSON, data);
}
