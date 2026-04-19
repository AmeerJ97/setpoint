/**
 * Combined consumption+projection gauge.
 *
 *   ▕████▓▓░──┤78┤░░░▏
 *    │   │   │    │
 *    │   │   │    └─ headroom (dim)
 *    │   │   └─ projection anchor (inverted-video label)
 *    │   └─ projected delta (mid shade)
 *    └─ consumed (colored by level)
 *
 * Used by both the Usage line (5h / 7d windows) and the Advisor line
 * (most-pressing window). Level color comes from a state-keyed lookup
 * (ok/watch/tight/critical) so the same primitive works for both
 * semantic and gradient palettes.
 */

import { dim, RESET, setColorMode as _unused } from './colors.js';
import { getPalette } from './palettes.js';
import { detectPalette } from './capability.js';
import { ansiTrueColor, ansi256FromRgb } from './gradient.js';

const LEVEL_TO_STATE = {
  ok: 'ok', watch: 'info', tight: 'warn', critical: 'critical', hit: 'critical',
};

function stateEscape(state) {
  const rgb = getPalette(detectPalette()).stateColor(state);
  if (!rgb) return '';
  // We pick truecolor unconditionally here because gauge callers have
  // already screened for color support upstream via coloredBar / dim()
  // behaviour. If the overall mode is 'none', dim() will strip escapes
  // and the bar degrades to plain block characters.
  return ansiTrueColor(rgb);
}

/**
 * Render a combined gauge.
 *
 * @param {object} opts
 * @param {string} opts.label           — e.g. "5h", "7d"
 * @param {number} opts.current         — 0..100 current consumption
 * @param {number} [opts.projected]     — 0..1 projected consumption at reset
 * @param {string} [opts.level]         — ok/watch/tight/critical/hit
 * @param {number} [opts.width=16]      — rail width in cells
 * @returns {string}
 */
export function combinedGauge({ label, current, projected, level = 'ok', width = 16 }) {
  const curPct = Math.max(0, Math.min(100, current ?? 0));
  const projPct = projected != null
    ? Math.max(curPct, Math.min(100, projected * 100))
    : curPct;

  const curCells  = Math.round((curPct  / 100) * width);
  const projCells = Math.round((projPct / 100) * width);
  const deltaCells = Math.max(0, projCells - curCells);
  const tailCells  = Math.max(0, width - curCells - deltaCells);

  const state = LEVEL_TO_STATE[level] ?? 'ok';
  const color = stateEscape(state);

  const filled = color + '█'.repeat(curCells) + RESET;
  const delta = deltaCells > 0 ? dim('▓'.repeat(deltaCells)) : '';
  const tail = tailCells > 0 ? dim('─'.repeat(tailCells)) : '';

  const cap0 = dim('▕');
  const cap1 = dim('▏');

  const labelChip = label ? `${dim(label)} ` : '';
  const value = projected != null && projected > 0 && curPct > 0
    ? ` ${dim(`${Math.round(curPct)}→${Math.round(projPct)}`)}`
    : ` ${dim(`${Math.round(curPct)}%`)}`;

  return `${labelChip}${cap0}${filled}${delta}${tail}${cap1}${value}`;
}
