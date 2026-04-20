/**
 * Rate projection engine — sigmoid-blended dual-rate projection with historical priors.
 *
 * Early in a window: trusts prior-window history over sparse current data.
 * Late in a window: trusts observed current rate.
 * Blend uses sigmoid weighting for smooth confidence transition.
 *
 * Based on Google SRE burn-rate alerting and sliding-window rate patterns.
 */

import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';
import { findActiveSessions } from '../data/session.js';
import { getRatesTuning } from '../data/defaults.js';

/**
 * @typedef {object} WindowProjection
 * @property {number} current
 * @property {number} projected
 * @property {number|null} tte
 * @property {number} burnFracPerMin
 * @property {string|null} resetIn
 * @property {'ok'|'watch'|'tight'|'critical'|'hit'} level
 * @property {boolean} peakActive    - true when current local time is in the peak-hour window
 * @property {number} peakFraction   - fraction of remaining window that falls in peak hours (0..1)
 * @property {number} peakMultiplier - the multiplier applied to peak-hour minutes
 */

/**
 * @typedef {object} RateData
 * @property {number} fiveHourProjected
 * @property {number} sevenDayProjected
 * @property {number} burnRate
 * @property {WindowProjection|null} fiveHourDetail
 * @property {WindowProjection|null} sevenDayDetail
 * @property {number} estimatedSessions
 */

const SIGMOID_STEEPNESS = 8;
const SIGMOID_CENTER = 0.35;

function sigmoidWeight(t) {
  return 1 / (1 + Math.exp(-SIGMOID_STEEPNESS * (t - SIGMOID_CENTER)));
}

/**
 * Hour-of-day in the configured timezone. Returns 0..23.
 * @param {number} epochMs
 * @param {string} timezone
 * @returns {number}
 */
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

/**
 * True when `hour` falls inside `[startHour, endHour)`, with wrap-around
 * support (e.g. 22..6 means 22, 23, 0, 1, 2, 3, 4, 5).
 */
function isPeakHour(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * Estimate what fraction of the next `remainingSec` seconds will fall
 * inside the peak window. Sampled at ~10-minute resolution; cheap
 * enough to call per render.
 *
 * @param {number} nowMs
 * @param {number} remainingSec
 * @param {{ timezone: string, startHour: number, endHour: number }} peak
 * @returns {number} fraction in [0, 1]
 */
export function peakFractionOfRemaining(nowMs, remainingSec, peak) {
  if (remainingSec <= 0) return 0;
  if (peak.startHour === peak.endHour) return 0;
  const samples = Math.min(96, Math.max(6, Math.ceil(remainingSec / 600)));
  let peakSamples = 0;
  for (let i = 0; i < samples; i++) {
    const t = nowMs + (i / Math.max(1, samples - 1)) * remainingSec * 1000;
    if (isPeakHour(localHour(t, peak.timezone), peak.startHour, peak.endHour)) peakSamples++;
  }
  return peakSamples / samples;
}

/**
 * Project a single window's usage at reset.
 *
 * Phase 1.6: peak-hour weighting. Per #41930, Anthropic appears to
 * apply a silent multiplier on session-window consumption during US
 * business hours. We multiply the projected consumption for whatever
 * fraction of the remaining window falls inside the configured peak
 * window. This makes "safe headroom" honest — projections that
 * previously assumed uniform burn no longer evaporate the moment 5am
 * PT rolls around.
 *
 * @param {number} usedPct
 * @param {number} resetsAt - epoch seconds
 * @param {number} windowSec
 * @param {number|null} priorRate - fraction/sec from prior window
 * @returns {{ projected: number, tte: number|null, burnFracPerMin: number, peakActive: boolean, peakFraction: number, peakMultiplier: number }}
 */
export function projectWindow(usedPct, resetsAt, windowSec, priorRate) {
  const now = Date.now() / 1000;
  const consumed = usedPct / 100;
  const elapsed = Math.max(1, now - (resetsAt - windowSec));
  const remaining = Math.max(0, resetsAt - now);

  const tuning = getRatesTuning();
  const peak = tuning.peakHours;
  const peakActive = peak.enabled
    && isPeakHour(localHour(now * 1000, peak.timezone), peak.startHour, peak.endHour);

  if (remaining <= 0) {
    return {
      projected: consumed, tte: null, burnFracPerMin: 0,
      peakActive, peakFraction: 0, peakMultiplier: peak.enabled ? peak.multiplier : 1,
    };
  }

  const currentRate = consumed / elapsed;
  const t = Math.min(1, elapsed / windowSec);
  const w = sigmoidWeight(t);

  // When no prior data exists, use a conservative fallback.
  // For multi-day windows, usage only occurs during active hours (~10h/day
  // by default, tunable via config/defaults.json → rates.activeHoursPerDay),
  // not 24/7. Scale remaining time by an activity factor.
  // For short windows (<=6h), assume continuous activity.
  const activityFactor = windowSec > 6 * 3600
    ? tuning.activeHoursPerDay / 24
    : 1;
  const effectiveWindowSec = windowSec * activityFactor;
  const uniformRate = consumed / effectiveWindowSec;
  const prior = priorRate ?? uniformRate;
  const effectiveRate = w * currentRate + (1 - w) * prior;

  // For projection, also scale remaining time by activity factor when no prior
  const baseRemaining = priorRate != null
    ? remaining
    : remaining * activityFactor;

  // Peak-hour weighting. peakFraction × multiplier inflates the
  // fraction of remaining time that we expect to burn faster.
  const peakFraction = peak.enabled
    ? peakFractionOfRemaining(now * 1000, remaining, peak)
    : 0;
  const peakWeight = peak.enabled
    ? 1 + peakFraction * (peak.multiplier - 1)
    : 1;
  const effectiveRemaining = baseRemaining * peakWeight;

  const projected = Math.min(1, Math.max(consumed, consumed + effectiveRate * effectiveRemaining));
  const headroom = 1 - consumed;
  // TTE uses the (possibly peak-boosted) instantaneous rate so the
  // displayed exhaustion time honors the multiplier when peak is active.
  const ratePerSec = effectiveRate * (peakActive ? peak.multiplier : 1);
  const tte = ratePerSec > 0 ? Math.round(headroom / ratePerSec) : null;

  return {
    projected,
    tte,
    burnFracPerMin: effectiveRate * 60,
    peakActive,
    peakFraction,
    peakMultiplier: peak.enabled ? peak.multiplier : 1,
  };
}

/**
 * Compute prior window consumption rate from history.
 * @param {'five_hour'|'seven_day'} window
 * @param {number} resetsAt - epoch seconds
 * @param {number} windowSec
 * @returns {number|null} fraction consumed per second
 */
export function computePriorRate(window, resetsAt, windowSec) {
  const field = window === 'five_hour' ? 'five_hour_pct' : 'seven_day_pct';
  const history = readJsonlWindow(HISTORY_FILE, windowSec * 3 * 1000);
  if (history.length < 2) return null;

  const prevEnd = resetsAt - windowSec;
  const prevStart = prevEnd - windowSec;

  const entries = history.filter(e => {
    const ts = new Date(e.ts).getTime() / 1000;
    return ts >= prevStart && ts <= prevEnd && e[field] != null;
  });
  if (entries.length < 2) return null;

  const first = entries[0];
  const last = entries[entries.length - 1];
  const dt = (new Date(last.ts).getTime() - new Date(first.ts).getTime()) / 1000;
  if (dt <= 0) return null;

  return Math.max(0, ((last[field] - first[field]) / 100) / dt);
}

function estimateSessionCount() {
  try { return Math.max(1, findActiveSessions().length); }
  catch { return 1; }
}

function formatResetIn(resetAt) {
  if (!resetAt) return null;
  const diffMs = resetAt.getTime() - Date.now();
  if (diffMs <= 0) return null;
  const mins = Math.ceil(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rh = hours % 24;
    return rh > 0 ? `${days}d${rh}h` : `${days}d`;
  }
  return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
}

function classifyLevel(current, projected) {
  if (current === 100) return 'hit';
  // < 5% used: prior-window exhaustion can inflate projection via sigmoid; real headroom is 95%+
  if (current !== null && current < 5) return projected > 0.50 ? 'watch' : 'ok';
  const t = getRatesTuning().classifyLevel;  // { critical, tight, watch } as percentages
  if (projected > t.critical / 100) return 'critical';
  if (projected > t.tight / 100 || (current !== null && current > 80)) return 'tight';
  if (projected > t.watch / 100 || (current !== null && current > 50)) return 'watch';
  return 'ok';
}

function buildWindowProjection(usedPct, resetAt, windowSec, windowName) {
  if (usedPct === null || !resetAt) return null;
  const resetsAtSec = resetAt.getTime() / 1000;
  const priorRate = computePriorRate(windowName, resetsAtSec, windowSec);
  const { projected, tte, burnFracPerMin, peakActive, peakFraction, peakMultiplier } =
    projectWindow(usedPct, resetsAtSec, windowSec, priorRate);

  return {
    current: usedPct,
    projected,
    tte,
    burnFracPerMin,
    resetIn: formatResetIn(resetAt),
    level: classifyLevel(usedPct, projected),
    peakActive,
    peakFraction,
    peakMultiplier,
  };
}

/**
 * Calculate all rate projections.
 * @param {import('../data/stdin.js').UsageData|null} usageData
 * @param {number} [sessionBurnRate=0]
 * @returns {RateData}
 */
export function calculateRates(usageData, sessionBurnRate = 0) {
  const estimatedSessions = estimateSessionCount();
  let fiveHourDetail = null;
  let sevenDayDetail = null;

  if (usageData) {
    fiveHourDetail = buildWindowProjection(
      usageData.fiveHour, usageData.fiveHourResetAt, 5 * 3600, 'five_hour'
    );
    sevenDayDetail = buildWindowProjection(
      usageData.sevenDay, usageData.sevenDayResetAt, 7 * 86400, 'seven_day'
    );
  }

  return {
    fiveHourProjected: fiveHourDetail?.projected ?? 0,
    sevenDayProjected: sevenDayDetail?.projected ?? 0,
    burnRate: sessionBurnRate,
    fiveHourDetail,
    sevenDayDetail,
    estimatedSessions,
  };
}
