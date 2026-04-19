/**
 * Get the current terminal width. Tries stdout, stderr, then $COLUMNS.
 * @returns {number|null}
 */
export function getTerminalWidth() {
  const stdoutColumns = process.stdout?.columns;
  if (typeof stdoutColumns === 'number' && Number.isFinite(stdoutColumns) && stdoutColumns > 0) {
    return Math.floor(stdoutColumns);
  }
  // When running as statusline subprocess, stdout is piped but stderr is
  // still connected to the real terminal.
  const stderrColumns = process.stderr?.columns;
  if (typeof stderrColumns === 'number' && Number.isFinite(stderrColumns) && stderrColumns > 0) {
    return Math.floor(stderrColumns);
  }
  const envColumns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  if (Number.isFinite(envColumns) && envColumns > 0) return envColumns;
  return null;
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
