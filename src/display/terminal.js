import { readlinkSync, readFileSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Get the current terminal width.
 *
 * Claude Code invokes the statusLine as a subprocess with stdin/stdout/stderr
 * piped — no TTY, no COLUMNS env. To determine the *real* terminal width we
 * walk the parent-process tree on Linux, find the first ancestor with a
 * controlling TTY (`/proc/PID/fd/0` → `/dev/pts/N`), and query its size
 * via `stty size < /dev/pts/N`. Result is cached per-invocation.
 *
 * @returns {number|null}
 */
let _cachedWidth = undefined;

export function getTerminalWidth() {
  if (_cachedWidth !== undefined) return _cachedWidth;
  _cachedWidth = detectTerminalWidth();
  return _cachedWidth;
}

function detectTerminalWidth() {
  const stdoutColumns = process.stdout?.columns;
  if (typeof stdoutColumns === 'number' && Number.isFinite(stdoutColumns) && stdoutColumns > 0) {
    return Math.floor(stdoutColumns);
  }
  const stderrColumns = process.stderr?.columns;
  if (typeof stderrColumns === 'number' && Number.isFinite(stderrColumns) && stderrColumns > 0) {
    return Math.floor(stderrColumns);
  }
  const envColumns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(envColumns) && envColumns > 0) return envColumns;

  const ttyWidth = widthFromParentTty();
  if (ttyWidth) return ttyWidth;

  return null;
}

function widthFromParentTty() {
  try {
    let pid = process.ppid;
    for (let hops = 0; hops < 6 && pid && pid > 1; hops++) {
      const ttyPath = safeReadlink(`/proc/${pid}/fd/0`)
        ?? safeReadlink(`/proc/${pid}/fd/1`)
        ?? safeReadlink(`/proc/${pid}/fd/2`);
      if (ttyPath && /^\/dev\/(pts\/\d+|tty\w*)$/.test(ttyPath)) {
        const ttyFd = openSync(ttyPath, 'r');
        const result = spawnSync('stty', ['size'], {
          stdio: [ttyFd, 'pipe', 'pipe'],
          timeout: 500,
          encoding: 'utf8',
        });
        closeSync(ttyFd);
        if (result.status === 0 && result.stdout) {
          const parts = result.stdout.trim().split(/\s+/);
          const cols = Number.parseInt(parts[1], 10);
          if (Number.isFinite(cols) && cols > 0) return cols;
        }
      }
      pid = getParentPid(pid);
    }
  } catch { /* ignore */ }
  return null;
}

function safeReadlink(path) {
  try { return readlinkSync(path); } catch { return null; }
}

function getParentPid(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^PPid:\s+(\d+)/m);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch { return null; }
}

/**
 * Get adaptive progress bar width based on terminal width.
 * Wide (>=100): 10, Medium (60-99): 6, Narrow (<60): 4. Default: 10.
 * @returns {number}
 */
export function getAdaptiveBarWidth() {
  const cols = getTerminalWidth();
  if (cols !== null) {
    if (cols >= 100) return 10;
    if (cols >= 60) return 6;
    return 4;
  }
  return 10;
}

/**
 * Check if terminal is narrow (< threshold chars).
 * @param {number} [threshold=100]
 * @returns {boolean}
 */
export function isNarrowTerminal(threshold = 100) {
  const cols = getTerminalWidth();
  return cols !== null && cols < threshold;
}
