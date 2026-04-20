/**
 * Color system for setpoint.
 *
 * Two classes of color:
 *   1. Named ANSI colors (green, yellow, red, cyan, dim, bold) — emit a
 *      fixed SGR escape. Used when the caller has already decided on a
 *      specific color (error messages, dimmed labels, etc.).
 *   2. Threshold colors (getContextColor, getQuotaColor, …) — select a
 *      color based on a numeric value. In truecolor/ansi256 modes these
 *      interpolate in Oklab between palette state stops, giving smooth
 *      transitions instead of 3 hard bands. In ansi16 mode they fall
 *      back to classic SGR 32/33/31.
 *
 * NO_COLOR, SETPOINT_PLAIN, and non-TTY stdout are all honoured — in
 * those modes every function returns plain text with no escapes.
 *
 * Callers set the mode automatically via the first lookup; tests can
 * force a mode with setColorMode().
 */

import { ansiTrueColor, ansi256FromRgb } from './gradient.js';
import { getPalette } from './palettes.js';
import { detectColorSupport, detectPalette } from './capability.js';

/* -------------------------------------------------------------------- */
/* Mode + palette (lazy, cached, overrideable)                           */
/* -------------------------------------------------------------------- */

/** @type {import('./capability.js').ColorSupport | null} */
let cachedMode = null;
/** @type {ReturnType<typeof getPalette> | null} */
let cachedPalette = null;

function mode() {
  if (cachedMode == null) cachedMode = detectColorSupport();
  return cachedMode;
}
function palette() {
  if (cachedPalette == null) cachedPalette = getPalette(detectPalette());
  return cachedPalette;
}

/**
 * Force a specific color support mode. Primarily for tests; resets
 * caches so subsequent lookups use the supplied mode.
 * @param {import('./capability.js').ColorSupport | null} [newMode] - null clears the override
 * @param {string} [paletteName] - optional palette override ('cividis'|'rag')
 */
export function setColorMode(newMode = null, paletteName = null) {
  cachedMode = newMode;
  cachedPalette = paletteName ? getPalette(paletteName) : null;
}

/* -------------------------------------------------------------------- */
/* Static SGR constants (ANSI 16-color)                                  */
/* -------------------------------------------------------------------- */

export const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';

/* -------------------------------------------------------------------- */
/* Low-level: wrap a raw SGR escape around text, respecting mode        */
/* -------------------------------------------------------------------- */

function colorize(text, escape) {
  if (mode() === 'none') return String(text);
  return `${escape}${text}${RESET}`;
}

export function green(text)   { return colorize(text, GREEN); }
export function yellow(text)  { return colorize(text, YELLOW); }
export function red(text)     { return colorize(text, RED); }
export function cyan(text)    { return colorize(text, CYAN); }
export function magenta(text) { return colorize(text, MAGENTA); }
export function dim(text)     { return colorize(text, DIM); }
export function bold(text)    { return colorize(text, BOLD); }

/* -------------------------------------------------------------------- */
/* Gradient color production                                             */
/* -------------------------------------------------------------------- */

/**
 * Given an RGB tuple, produce the appropriate ANSI escape for the
 * current mode. Returns '' for mode='none'. For 'ansi16' returns a
 * best-approximate SGR 30-37/90-97 escape via the caller-supplied
 * `ansi16Fallback` — we don't auto-quantize to ansi16 because it
 * looks worse than the legacy 3-band mapping for threshold colors.
 *
 * @param {[number, number, number]} rgb
 * @param {string} [ansi16Fallback] - SGR string to use in 16-color mode
 * @returns {string}
 */
function rgbEscape(rgb, ansi16Fallback = '') {
  const m = mode();
  if (m === 'none') return '';
  if (m === 'ansi16') return ansi16Fallback;
  if (m === 'ansi256') return ansi256FromRgb(rgb);
  return ansiTrueColor(rgb);
}

/**
 * Threshold color. Snaps to the state color of the band the value
 * falls into — no interpolation. Oklab mixing between state stops
 * produced muddy olive / beige mid-tones that read as "pasty" on a
 * statusLine; vivid discrete state colors read crisply at a glance,
 * which is what the HUD actually wants.
 *
 * @param {number} value
 * @param {Array<{ at: number, state: string, ansi16?: string }>} stops
 * @returns {string} ANSI escape (or '' when color disabled)
 */
function thresholdColor(value, stops) {
  const m = mode();
  if (m === 'none') return '';

  if (!Number.isFinite(value)) value = 0;

  // Clamp to the range
  if (value <= stops[0].at) {
    return rgbEscape(palette().stateColor(stops[0].state), stops[0].ansi16);
  }
  if (value >= stops[stops.length - 1].at) {
    const s = stops[stops.length - 1];
    return rgbEscape(palette().stateColor(s.state), s.ansi16);
  }

  // Snap to the left stop's state color across the whole segment.
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value >= a.at && value < b.at) {
      if (m === 'ansi16') return a.ansi16;
      return rgbEscape(palette().stateColor(a.state), a.ansi16);
    }
  }
  return '';
}

/* -------------------------------------------------------------------- */
/* Threshold color API (backward compatible)                             */
/* -------------------------------------------------------------------- */

const CONTEXT_STOPS = [
  { at:  0, state: 'ok',        ansi16: GREEN },
  { at: 70, state: 'warn',      ansi16: YELLOW },
  { at: 85, state: 'critical',  ansi16: RED },
  { at:100, state: 'critical',  ansi16: RED },
];

const QUOTA_STOPS = [
  { at:  0, state: 'ok',        ansi16: GREEN },
  { at: 50, state: 'warn',      ansi16: YELLOW },
  { at: 80, state: 'critical',  ansi16: RED },
  { at:100, state: 'critical',  ansi16: RED },
];

const BURN_STOPS = [
  { at:   0, state: 'ok',       ansi16: GREEN },
  { at: 200, state: 'warn',     ansi16: YELLOW },
  { at:1000, state: 'critical', ansi16: RED },
];

const CACHE_STOPS = [
  { at:  0, state: 'critical',  ansi16: RED },
  { at: 50, state: 'warn',      ansi16: YELLOW },
  { at: 80, state: 'ok',        ansi16: GREEN },
  { at:100, state: 'ok',        ansi16: GREEN },
];

export function getContextColor(percent) { return thresholdColor(percent, CONTEXT_STOPS); }
export function getQuotaColor(percent)   { return thresholdColor(percent, QUOTA_STOPS); }
export function getBurnColor(rate)       { return thresholdColor(rate,    BURN_STOPS); }
export function getCacheColor(percent)   { return thresholdColor(percent, CACHE_STOPS); }

/**
 * Effort level → color. Still a qualitative mapping, not a gradient.
 */
export function getEffortColor(effort) {
  const m = mode();
  if (m === 'none') return '';
  const state =
    effort === 'high' || effort === 'max' ? 'ok'
      : effort === 'medium'               ? 'warn'
      :                                     'critical';
  return rgbEscape(
    palette().stateColor(state),
    state === 'ok' ? GREEN : state === 'warn' ? YELLOW : RED,
  );
}

/* -------------------------------------------------------------------- */
/* Progress bar helpers                                                  */
/* -------------------------------------------------------------------- */

/**
 * Render a progress bar.
 * @param {number} percent
 * @param {number} [width=10]
 * @param {function} [colorFn=getContextColor]
 * @returns {string}
 */
export function coloredBar(percent, width = 10, colorFn = getContextColor) {
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const filled = Math.round((safePercent / 100) * safeWidth);
  const empty = safeWidth - filled;
  const color = colorFn(safePercent);
  const dimEsc = mode() === 'none' ? '' : DIM;
  const reset = mode() === 'none' ? '' : RESET;
  return `${color}${'█'.repeat(filled)}${dimEsc}${'░'.repeat(empty)}${reset}`;
}

/**
 * Quota/usage bar.
 */
export function quotaBar(percent, width = 10) {
  return coloredBar(percent, width, getQuotaColor);
}

/**
 * Sub-character-precision bar using octant fill characters.
 * Gives 8× horizontal resolution: useful when the bar is narrow
 * (≤10 cells) but the caller wants smooth animation between values.
 *
 * Optional `markerAt` overlays a dim `╎` character at that percentage
 * position — used by the Context line to show where the autocompact
 * buffer pushes effective % vs. the raw fill. Marker is suppressed if
 * it would land inside the filled region.
 *
 * @param {number} percent 0..100
 * @param {number} [width=10] width in cells
 * @param {function} [colorFn=getContextColor]
 * @param {number} [markerAt] optional 0..100 marker position
 * @returns {string}
 */
export function octantBar(percent, width = 10, colorFn = getContextColor, markerAt) {
  const OCTANTS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
  const safeWidth = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const totalEighths = Math.round((safePercent / 100) * safeWidth * 8);
  const full = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;
  const empty = safeWidth - full - (remainder > 0 ? 1 : 0);
  const color = colorFn(safePercent);
  const dimEsc = mode() === 'none' ? '' : DIM;
  const reset = mode() === 'none' ? '' : RESET;

  const body = '█'.repeat(full) + (remainder > 0 ? OCTANTS[remainder] : '');
  const tail = '░'.repeat(Math.max(0, empty));

  // Marker overlay: only draws into the empty (dim) region so it doesn't
  // visually contradict the filled portion.
  const filledCells = full + (remainder > 0 ? 1 : 0);
  if (Number.isFinite(markerAt) && markerAt > safePercent && safeWidth > 0) {
    const m = Math.min(100, Math.max(0, markerAt));
    const markerCell = Math.min(safeWidth - 1, Math.floor((m / 100) * safeWidth));
    if (markerCell >= filledCells) {
      const offset = markerCell - filledCells;
      const before = tail.slice(0, offset);
      const after  = tail.slice(offset + 1);
      return `${color}${body}${dimEsc}${before}╎${after}${reset}`;
    }
  }

  return `${color}${body}${dimEsc}${tail}${reset}`;
}
