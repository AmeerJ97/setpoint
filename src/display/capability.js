/**
 * Terminal capability detection.
 *
 * Order matters: Claude Code invokes setpoint as a subprocess with
 * stdout piped into its own UI, so the child process is never a TTY —
 * but the user's terminal still renders the ANSI output. A pure
 * "!TTY → none" rule strips color in exactly the environment we
 * need to serve first. Color-signaling env vars therefore take
 * priority; the TTY check is only a tiebreaker when no other signal
 * is present.
 *
 * Fallback chain (walk until first match):
 *   1. NO_COLOR (any truthy)              → 'none'  (no-color.org)
 *   2. SETPOINT_PLAIN (any truthy)        → 'none'
 *   3. FORCE_COLOR=3                       → 'truecolor'  (npm convention)
 *   4. FORCE_COLOR=2                       → 'ansi256'
 *   5. FORCE_COLOR=1|true                  → 'ansi16'
 *   6. FORCE_COLOR=0                       → 'none'
 *   7. COLORTERM=truecolor|24bit           → 'truecolor'
 *   8. TERM contains "256color"/"direct"   → 'ansi256'
 *   9. TERM contains "truecolor"           → 'truecolor'
 *  10. TERM=dumb or empty AND not TTY      → 'none'
 *  11. TERM=dumb                            → 'none'
 *  12. any other TERM (TTY or not)         → 'ansi16'
 *  13. no signals at all AND not TTY       → 'none'
 *
 * Additionally:
 *   SETPOINT_PALETTE=cividis|rag     → palette name
 *   SETPOINT_NERD=1                  → opt-in Nerd-Font glyphs
 */

import { isatty } from 'node:tty';

/**
 * @typedef {'none'|'ansi16'|'ansi256'|'truecolor'} ColorSupport
 */

/**
 * @param {{ env?: NodeJS.ProcessEnv, isTTY?: boolean }} [ctx]
 * @returns {ColorSupport}
 */
export function detectColorSupport(ctx = {}) {
  const env = ctx.env ?? process.env;
  const tty = ctx.isTTY ?? Boolean(process.stdout && isatty(1));

  if (truthy(env.NO_COLOR))        return 'none';
  if (truthy(env.SETPOINT_PLAIN))  return 'none';

  // npm-ecosystem standard: FORCE_COLOR is the explicit override.
  const fc = (env.FORCE_COLOR ?? '').toString().trim().toLowerCase();
  if (fc === '0' || fc === 'false') return 'none';
  if (fc === '3')                   return 'truecolor';
  if (fc === '2')                   return 'ansi256';
  if (fc === '1' || fc === 'true')  return 'ansi16';

  const ct = (env.COLORTERM ?? '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';

  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('256color') || term.includes('direct')) return 'ansi256';
  if (term.includes('truecolor')) return 'truecolor';

  if (term === 'dumb') return 'none';

  // No explicit color hint. Fall back on TTY status to decide.
  // Piping to a file/logfile with no COLORTERM hint shouldn't inject
  // escape codes.
  if (!tty && term === '') return 'none';

  return 'ansi16';
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [ctx]
 * @returns {'cividis'|'rag'}
 */
export function detectPalette(ctx = {}) {
  const env = ctx.env ?? process.env;
  const p = (env.SETPOINT_PALETTE ?? '').toLowerCase().trim();
  if (p === 'cividis') return 'cividis';
  return 'rag';
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [ctx]
 * @returns {boolean}
 */
export function useNerdGlyphs(ctx = {}) {
  const env = ctx.env ?? process.env;
  return truthy(env.SETPOINT_NERD);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [ctx]
 * @returns {boolean}
 */
export function usePlainGlyphs(ctx = {}) {
  const env = ctx.env ?? process.env;
  return truthy(env.SETPOINT_PLAIN);
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase().trim();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
}
