/**
 * Structured error logging for claude-ops.
 * Writes to stderr with a consistent prefix so errors are visible
 * without polluting the HUD stdout output.
 */

const PREFIX = '[claude-ops]';

/**
 * Log a parse/data error. Silent production failure is the most expensive
 * kind of failure because it hides root causes. Every error logged here
 * is recoverable (the caller handles the null/fallback), but the evidence
 * is preserved.
 *
 * @param {string} message
 */
export function formatParseError(message) {
  console.error(`${PREFIX} ${message}`);
}

/**
 * Format an error for structured logging. Returns a plain object suitable
 * for JSONL output or debug rendering.
 *
 * @param {string} context - where the error occurred
 * @param {unknown} error - the thrown value
 * @returns {{ context: string, message: string, stack?: string }}
 */
export function formatStructuredError(context, error) {
  if (error instanceof Error) {
    return { context, message: error.message, stack: error.stack };
  }
  return { context, message: error != null ? String(error) : 'Unknown error' };
}
