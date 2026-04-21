/**
 * Peak-vs-off-peak burn split over a trailing usage-history window.
 *
 * Split out of src/advisor/index.js so the `setpoint advisor status`
 * drilldown can compute the split without pulling in the whole daily-report
 * pipeline (which reads session JSONLs, guard state, rtk stats, etc.).
 *
 * Reads tuning live from config defaults so the peak window follows the
 * user's configured timezone and hour range.
 */
import { getRatesTuning } from '../data/defaults.js';

/**
 * @typedef {object} PeakSplit
 * @property {number} peakAvg         - average burn rate in peak hours (t/m)
 * @property {number} offPeakAvg      - average burn rate off peak (t/m)
 * @property {number} peakSamples
 * @property {number} offPeakSamples
 * @property {number|null} ratio      - peakAvg / offPeakAvg, null when off-peak has no samples
 */

/**
 * @param {Array<{ ts?: string, session_burn_rate?: number }>} history
 * @returns {PeakSplit}
 */
export function computePeakSplit(history) {
  const peak = getRatesTuning().peakHours;
  if (!peak?.enabled) {
    return { peakAvg: 0, offPeakAvg: 0, peakSamples: 0, offPeakSamples: 0, ratio: null };
  }
  let peakSum = 0, offSum = 0, peakN = 0, offN = 0;
  for (const e of history) {
    if (!e.ts || !Number.isFinite(e.session_burn_rate)) continue;
    const hour = localHour(new Date(e.ts).getTime(), peak.timezone);
    const inPeak = peak.startHour < peak.endHour
      ? hour >= peak.startHour && hour < peak.endHour
      : hour >= peak.startHour || hour < peak.endHour;
    if (inPeak) { peakSum += e.session_burn_rate; peakN++; }
    else        { offSum  += e.session_burn_rate; offN++;  }
  }
  const peakAvg = peakN > 0 ? peakSum / peakN : 0;
  const offPeakAvg = offN > 0 ? offSum / offN : 0;
  const ratio = offPeakAvg > 0 ? peakAvg / offPeakAvg : null;
  return { peakAvg, offPeakAvg, peakSamples: peakN, offPeakSamples: offN, ratio };
}

function localHour(epochMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    });
    const h = parseInt(fmt.format(new Date(epochMs)), 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}
