/**
 * Desktop notification support for critical anomalies.
 * Uses notify-send on Linux, osascript on macOS.
 *
 * Stateless invocation model: the HUD pipeline invokes notify functions from a
 * fresh Node process on every status-line render, so any in-memory cooldown
 * resets each call. All dedupe state therefore lives on disk.
 *
 * Dedupe semantics:
 *   - Per-message: a given (title, message) hash fires at most once per
 *     SAME_MESSAGE_COOLDOWN_MS window (6 hours).
 *   - Global: at most one notification of any kind per GLOBAL_RATE_LIMIT_MS
 *     window (60 seconds) — guards against bursts of different anomalies.
 *   - To reset, delete ~/.claude/plugins/claude-ops/notify-state.json.
 *   - To disable entirely, set CLAUDE_OPS_NOTIFY=0.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const STATE_PATH = join(homedir(), '.claude/plugins/claude-ops/notify-state.json');
const GLOBAL_RATE_LIMIT_MS = 60_000;
const SAME_MESSAGE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h per unique anomaly
const SEEN_PRUNE_MS = 24 * 60 * 60 * 1000;

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return {
      lastNotifyTime: typeof raw.lastNotifyTime === 'number' ? raw.lastNotifyTime : 0,
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
    };
  } catch {
    return { lastNotifyTime: 0, seen: {} };
  }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, STATE_PATH);
  } catch { /* best-effort */ }
}

function hashKey(title, message) {
  return createHash('sha256').update(`${title}\0${message}`).digest('hex').slice(0, 16);
}

function pruneSeen(seen, now) {
  for (const k of Object.keys(seen)) {
    if (now - seen[k] > SEEN_PRUNE_MS) delete seen[k];
  }
}

export function isNotifyEnabled() {
  return process.env.CLAUDE_OPS_NOTIFY !== '0' &&
         process.env.CLAUDE_OPS_NOTIFY !== 'false';
}

/**
 * Send a desktop notification. Returns true iff a notification was actually
 * dispatched; false if disabled, deduplicated, rate-limited, or failed.
 *
 * @param {string} title
 * @param {string} message
 * @param {'critical'|'warn'|'info'} [urgency='warn']
 * @returns {Promise<boolean>}
 */
export async function sendNotification(title, message, urgency = 'warn') {
  if (!isNotifyEnabled()) return false;

  const now = Date.now();
  const state = loadState();
  const key = hashKey(title, message);

  if (now - state.lastNotifyTime < GLOBAL_RATE_LIMIT_MS) return false;
  if (state.seen[key] && now - state.seen[key] < SAME_MESSAGE_COOLDOWN_MS) return false;

  const os = platform();
  try {
    if (os === 'linux') {
      await sendLinuxNotification(title, message, urgency);
    } else if (os === 'darwin') {
      await sendMacNotification(title, message);
    } else {
      return false;
    }
    state.lastNotifyTime = now;
    state.seen[key] = now;
    pruneSeen(state.seen, now);
    saveState(state);
    return true;
  } catch {
    return false;
  }
}

function sendLinuxNotification(title, message, urgency) {
  return new Promise((resolve, reject) => {
    const urgencyMap = { critical: 'critical', warn: 'normal', info: 'low' };
    execFile('notify-send', [
      '--app-name=Claude Ops',
      `--urgency=${urgencyMap[urgency] ?? 'normal'}`,
      '--icon=dialog-warning',
      title,
      message,
    ], { timeout: 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendMacNotification(title, message) {
  return new Promise((resolve, reject) => {
    const sanitise = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${sanitise(message)}" with title "${sanitise(title)}"`;
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Notify for critical anomalies from the anomaly list.
 * @param {Array<{triggered: boolean, message: string, severity?: string}>} anomalies
 */
export async function notifyCriticalAnomalies(anomalies) {
  const critical = anomalies.filter(a => a.triggered && a.severity === 'critical');
  if (critical.length === 0) return;
  const first = critical[0];
  await sendNotification('Claude Ops Alert', first.message, 'critical');
}
