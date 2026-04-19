/**
 * Desktop notification support for critical anomalies.
 * Uses notify-send on Linux, osascript on macOS.
 */
import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const NOTIFY_COOLDOWN_MS = 60_000; // Don't spam — max 1 notification per minute
let lastNotifyTime = 0;

/**
 * Check if desktop notifications are enabled.
 * @returns {boolean}
 */
export function isNotifyEnabled() {
  return process.env.CLAUDE_HUD_NOTIFY !== '0' &&
         process.env.CLAUDE_HUD_NOTIFY !== 'false';
}

/**
 * Send a desktop notification for a critical anomaly.
 * Respects cooldown to avoid notification spam.
 *
 * @param {string} title
 * @param {string} message
 * @param {'critical'|'warn'|'info'} [urgency='warn']
 * @returns {Promise<boolean>} true if notification was sent
 */
export async function sendNotification(title, message, urgency = 'warn') {
  if (!isNotifyEnabled()) return false;

  const now = Date.now();
  if (now - lastNotifyTime < NOTIFY_COOLDOWN_MS) return false;

  const os = platform();

  try {
    if (os === 'linux') {
      await sendLinuxNotification(title, message, urgency);
    } else if (os === 'darwin') {
      await sendMacNotification(title, message);
    } else {
      return false; // Windows not supported yet
    }
    lastNotifyTime = now;
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} title
 * @param {string} message
 * @param {string} urgency
 * @returns {Promise<void>}
 */
function sendLinuxNotification(title, message, urgency) {
  return new Promise((resolve, reject) => {
    const urgencyMap = {
      critical: 'critical',
      warn: 'normal',
      info: 'low',
    };
    execFile('notify-send', [
      '--app-name=Claude HUD',
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

/**
 * @param {string} title
 * @param {string} message
 * @returns {Promise<void>}
 */
function sendMacNotification(title, message) {
  return new Promise((resolve, reject) => {
    const script = `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`;
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
  await sendNotification(
    'Claude HUD Alert',
    first.message,
    'critical'
  );
}
