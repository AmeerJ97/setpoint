/**
 * Baselines — derive personal P50/P90 from the user's own usage-history.jsonl.
 *
 * The static thresholds in v1 (e.g. "burn rate > 1000 = high") were one-size-
 * fits-all. A user who routinely runs at 800 t/m looks "yellow" all day; a user
 * who normally idles at 50 t/m has no signal that 400 t/m is a 8× spike for
 * them. P90 baselining over the trailing 30 days fixes that — every threshold
 * becomes "% of your own normal" instead of "% of someone else's average".
 *
 * Baselining requires data. Until ≥7 days of history exist, we fall back to
 * the static defaults so a fresh install isn't useless.
 */

const BASELINE_MIN_SAMPLES = 50;
const BASELINE_MIN_DAYS = 7;

/**
 * @typedef {object} Baselines
 * @property {boolean} sufficient
 * @property {number|null} burnP50
 * @property {number|null} burnP90
 * @property {number|null} contextP50
 * @property {number|null} contextP90
 * @property {number} samples
 * @property {number} daysSpanned
 */

/**
 * @param {Array<{ ts?: string, session_burn_rate?: number, context_pct?: number }>} history
 * @returns {Baselines}
 */
export function computeBaselines(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return emptyBaselines();
  }

  const sorted = [...history].sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return ta - tb;
  });

  const oldest = sorted[0]?.ts ? new Date(sorted[0].ts).getTime() : null;
  const newest = sorted[sorted.length - 1]?.ts
    ? new Date(sorted[sorted.length - 1].ts).getTime()
    : null;
  const daysSpanned = (oldest && newest)
    ? (newest - oldest) / 86_400_000
    : 0;

  const sufficient = sorted.length >= BASELINE_MIN_SAMPLES
    && daysSpanned >= BASELINE_MIN_DAYS;

  if (!sufficient) {
    return { ...emptyBaselines(), samples: sorted.length, daysSpanned };
  }

  const burns = sorted
    .map(e => e.session_burn_rate)
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const ctx = sorted
    .map(e => e.context_pct)
    .filter(v => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  return {
    sufficient: true,
    burnP50: percentile(burns, 0.50),
    burnP90: percentile(burns, 0.90),
    contextP50: percentile(ctx, 0.50),
    contextP90: percentile(ctx, 0.90),
    samples: sorted.length,
    daysSpanned,
  };
}

/**
 * Linear-interpolated percentile of a sorted ascending array.
 * Returns null when the array is empty.
 * @param {number[]} sortedAsc
 * @param {number} p - percentile in [0, 1]
 */
export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const clamped = Math.max(0, Math.min(1, p));
  const pos = clamped * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function emptyBaselines() {
  return {
    sufficient: false,
    burnP50: null,
    burnP90: null,
    contextP50: null,
    contextP90: null,
    samples: 0,
    daysSpanned: 0,
  };
}
