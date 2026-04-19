/**
 * Combined consumption+projection gauge.
 *
 *   ▕█████████▓▓░░░░░▏ 62→78
 *    │        │   │
 *    │        │   └─ headroom (░, dim so the consumed block pops)
 *    │        └─ projected delta (▓, mid shade)
 *    └─ consumed (solid █ in the band's state color)
 *
 * Used on the Usage line (5h / 7d windows) and the Advisor line. The
 * level argument drives color; if omitted, it's derived from `current`
 * against the same thresholds as getQuotaColor — so a 62% bar is
 * always yellow regardless of whether an advisory level has been
 * computed yet.
 */

import { dim, RESET } from './colors.js';
import { getPalette } from './palettes.js';
import { detectPalette } from './capability.js';
import { ansiTrueColor } from './gradient.js';

const LEVEL_TO_STATE = {
  ok: 'ok', watch: 'info', tight: 'warn', critical: 'critical', hit: 'critical',
};

/**
 * Derive a level from a current percentage using quota thresholds:
 * 0–49 → ok, 50–79 → tight (warn), 80+ → critical.
 */
function levelFromCurrent(pct) {
  if (pct >= 80) return 'critical';
  if (pct >= 50) return 'tight';
  return 'ok';
}

function stateEscape(state) {
  const rgb = getPalette(detectPalette()).stateColor(state);
  if (!rgb) return '';
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
export function combinedGauge({ label, current, projected, level, width = 16 }) {
  const curPct = Math.max(0, Math.min(100, current ?? 0));
  const projPct = projected != null
    ? Math.max(curPct, Math.min(100, projected * 100))
    : curPct;

  const curCells  = Math.round((curPct  / 100) * width);
  const projCells = Math.round((projPct / 100) * width);
  const deltaCells = Math.max(0, projCells - curCells);
  const tailCells  = Math.max(0, width - curCells - deltaCells);

  const resolvedLevel = level ?? levelFromCurrent(curPct);
  const state = LEVEL_TO_STATE[resolvedLevel] ?? 'ok';
  const color = stateEscape(state);

  const filled = color + '█'.repeat(curCells) + RESET;
  // Projection delta: same state color but mid-density block. Reads
  // as "this is where the consumed band is heading" without washing out.
  const delta = deltaCells > 0 ? color + '▓'.repeat(deltaCells) + RESET : '';
  // Headroom: dim ░ — solid enough to frame the filled bar, dim
  // enough that the consumed segment pops.
  const tail = tailCells > 0 ? dim('░'.repeat(tailCells)) : '';

  const cap0 = dim('▕');
  const cap1 = dim('▏');

  // Value label matches the bar's color so the number reads at a glance.
  const numStr = projected != null && projected > 0 && curPct > 0
    ? `${Math.round(curPct)}→${Math.round(projPct)}`
    : `${Math.round(curPct)}%`;
  const value = ` ${color}${numStr}${RESET}`;

  const labelChip = label ? `${dim(label)} ` : '';

  return `${labelChip}${cap0}${filled}${delta}${tail}${cap1}${value}`;
}
