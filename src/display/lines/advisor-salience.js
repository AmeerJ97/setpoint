/**
 * Advisor-line trailing salience segment.
 *
 * One trailing chip after the standard gauge/TTE/conf/badge columns,
 * surfacing the single most-anomalous metric that isn't already the
 * primary action. Priority order — first check that fires wins:
 *
 *   1. burnVelocity > BURN_X_P50        → `⚡ burn {x}× P50`
 *   2. peak window dominates current %  → `◆ peak {n}%`
 *   3. R:E < WARN threshold and enough edits → `◐ R:E {r}`
 *
 * A check only fires when the backing datum exists. Missing baselines or
 * no R:E samples → omit the segment. The segment is an *addition* to the
 * line, never a stand-in for data — if nothing salient, render nothing.
 *
 * Reversals-per-1k gets its own warn-anomaly channel (see
 * src/anomaly/rules/reversals.js) and is intentionally *not* in this
 * picker — a warn badge is a better surface for that signal than a
 * crowded salience slot.
 */
import { dim, yellow, cyan } from '../colors.js';
import {
  RE_RATIO_WARN,
  RE_MIN_EDITS,
} from '../../anomaly/constants.js';

const BURN_X_P50 = 2.0;       // 2× personal P50 is the anomaly floor
const PEAK_DOMINANT_PCT = 0.60;

/**
 * Pick one salience segment, or return null when nothing stands out.
 * @param {{ metrics?: object }} advisory
 * @param {{ peakFraction?: number, peakActive?: boolean, peakMultiplier?: number }} [window]
 * @returns {string|null}
 */
export function pickSalienceSegment(advisory, window) {
  const m = advisory?.metrics;
  if (!m) return null;

  // 1. Burn velocity — burnVelocity is already burn/P50 (so "> 2" means
  //    the user is burning 2× their own rolling baseline). Only renders
  //    when the baseline exists (burnVelocity is null otherwise).
  if (Number.isFinite(m.burnVelocity) && m.burnVelocity >= BURN_X_P50) {
    const x = m.burnVelocity.toFixed(1);
    return `${yellow('⚡')} ${dim('burn')} ${yellow(`${x}×`)} ${dim('P50')}`;
  }

  // 2. Peak dominance — peakFraction is the share of the remaining
  //    window that falls inside peak hours. When it's majority AND peak
  //    actually inflates burn, flag it.
  const pf = window?.peakFraction;
  const pm = window?.peakMultiplier;
  if (Number.isFinite(pf) && pf >= PEAK_DOMINANT_PCT
      && Number.isFinite(pm) && pm > 1) {
    return `${cyan('◆')} ${dim('peak')} ${cyan(`${Math.round(pf * 100)}%`)}`;
  }

  // 3. R:E below the warn band with enough editing activity to be
  //    meaningful. Mirrors the anomaly-rule thresholds in constants.js
  //    so the two channels agree on what "degraded" means.
  if (Number.isFinite(m.ratio) && m.ratio < RE_RATIO_WARN
      && Number.isFinite(m.edits) && m.edits >= RE_MIN_EDITS) {
    return `${yellow('◐')} ${dim('R:E')} ${yellow(m.ratio.toFixed(1))}`;
  }

  return null;
}
