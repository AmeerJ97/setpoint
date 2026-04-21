/**
 * Advisor line — single-glance answer to "am I ok, and what should I do".
 *
 * Layout (wide):
 *   Advisor 5h ▕██▓▓─────▏ 62→78 │ TTE 6h │ conf:med │ ▼ /compact — ctx > 60%
 *   Advisor 7d ▕█████▓──────────▏ 38→52 │ TTE --  │ conf:high │ ▲ on track
 *
 * Burn rate lives on the Tokens line (not duplicated here). TTE is always
 * rendered — dim when outside the danger band — so the affordance stays
 * visible and the user doesn't have to guess whether the feature is on.
 * Confidence is a first-class `conf:` column so the reader can tell at a
 * glance how trustworthy the recommendation is.
 *
 * Anomaly alerts still override (critical first, warn next).
 */
import { dim, green, yellow, red, cyan, RESET } from '../colors.js';
import { padLabel } from '../format.js';
import { truncateToWidth } from '../text.js';
import { pickSalienceSegment } from './advisor-salience.js';

const SEP = ` ${dim('│')} `;

const SIGNAL_CONFIG = {
  increase:  { icon: '▲', color: green,  defaultLabel: 'on track' },
  nominal:   { icon: '──', color: dim,   defaultLabel: 'nominal' },
  reduce:    { icon: '▼', color: yellow, defaultLabel: 'caution' },
  throttle:  { icon: '⚠', color: red,    defaultLabel: 'throttle' },
  limit_hit: { icon: '⛔', color: red,    defaultLabel: 'limit hit' },
};

const LEVEL_COLOR = {
  ok: green, watch: cyan, tight: yellow, critical: red, hit: red,
};

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderAdvisorLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Adv' : 'Advisor', narrow);

  // Anomaly priority — ONLY critical severity takes over the line
  // (rogue agent, config tampering, true emergencies). Warn-level
  // anomalies (e.g., background drain) ride as a trailing badge so
  // the main advisor content stays visible.
  const anomalies = ctx.anomalies ?? [];
  const critical = anomalies.find(a => a.severity === 'critical');
  if (critical) {
    return `${dim(label)} ${red(`⚠ ${critical.message}`)}`;
  }
  const warn = anomalies.find(a => a.severity === 'warn' || !a.severity);

  // Normal advisory — render gauge + TTE + conf + action even when
  // no projection yet (placeholder rail). Warn anomaly appended as
  // a badge at the end.
  const advisory = ctx.advisory;
  if (!advisory) {
    const head = `${dim(label)} ${dim('── no data')}`;
    return warn ? `${head}${SEP}${yellow(`△ ${warn.message}`)}` : head;
  }

  const config = SIGNAL_CONFIG[advisory.signal] ?? SIGNAL_CONFIG.nominal;
  // When confidence is low AND the tier is the default "ok" rung (no real
  // recommendation yet — engine hasn't seen enough data), dim the badge and
  // prefix with `~` so the reader doesn't mistake a warming-up default for a
  // measured "on track" call. Any other tier (model_swap, compact, hard_stop)
  // or confidence ≥ med keeps full color.
  const warmingUp =
    advisory.confidence === 'low' && (advisory.tier ?? 'ok') === 'ok';
  const baseText = advisory.action ?? config.defaultLabel;
  const text = warmingUp ? `${baseText} — warming up` : baseText;
  const recBadge = warmingUp
    ? dim(`~ ${text}`)
    : renderActionBadge(config, text);

  // Pick the most-pressing window (higher of the two projections).
  const primaryWindow = pickPrimaryWindow(advisory);

  const parts = [];
  if (!narrow) {
    parts.push(renderCombinedGauge(primaryWindow));
    parts.push(renderTte(primaryWindow));
    parts.push(renderConfidence(advisory.confidence));
  }

  parts.push(recBadge);

  // Wide-mode only: one trailing "this is the single most anomalous
  // metric right now" segment. Silent when no baseline beats the
  // threshold — the Advisor line must never fabricate salience.
  if (!narrow) {
    const salience = pickSalienceSegment(advisory, primaryWindow);
    if (salience) parts.push(salience);
  }

  // Trailing warn badge — condensed, so it doesn't dominate.
  if (warn) {
    const extra = anomalies.filter(a => a.severity === 'warn' || !a.severity).length - 1;
    const suffix = extra > 0 ? dim(` +${extra}`) : '';
    const badge = `${yellow(`△ ${warn.message}`)}${suffix}`;
    parts.push(truncateToWidth(badge, 40));
  }

  return `${dim(label)} ${parts.join(SEP)}`;
}

/**
 * Action badge — icon + text, colored by the signal's urgency. Confidence
 * is surfaced separately in the `conf:` column so intensity here is purely
 * a function of signal severity.
 */
function renderActionBadge(config, text) {
  return config.color(`${config.icon} ${text}`);
}

/**
 * Explicit confidence column — reader can tell at a glance whether the
 * engine has enough data to back the call. `conf:high` green, `conf:med`
 * yellow, `conf:low` dim, missing → dim `conf:--`.
 */
function renderConfidence(conf) {
  if (conf === 'high') return `${dim('conf:')}${green('high')}`;
  if (conf === 'med')  return `${dim('conf:')}${yellow('med')}`;
  return `${dim('conf:')}${dim('low')}`;
}

/**
 * Time-to-exhaustion column. Always rendered so the affordance stays
 * visible; dim outside the danger band so the eye skips it. Same
 * thresholds as the previous Usage-line TTE: 5h < 2h, 7d < 36h.
 */
function renderTte(w) {
  const tteSec = w?.tte;
  const placeholder = w?.placeholder;
  if (placeholder || !Number.isFinite(tteSec) || tteSec <= 0) {
    return dim('TTE --');
  }
  const label = w.label ?? '';
  const duration = formatDuration(tteSec);
  // Danger band thresholds — same as the former usage-line encoding.
  const danger5h = label === '5h' && tteSec < 2 * 3600;
  const danger7d = label === '7d' && tteSec < 36 * 3600;
  if (danger5h) return red(`TTE ${duration}`);
  if (danger7d) {
    const color = tteSec < 12 * 3600 ? red : yellow;
    return color(`TTE ${duration}`);
  }
  return `${dim('TTE ')}${dim(duration)}`;
}

function formatDuration(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d${remH}h` : `${d}d`;
}

/**
 * Return the window with the higher projected-at-reset consumption.
 *
 * Always returns an object (never null) so the forecasting rail is
 * visible on every render. When neither window has data yet, a
 * `placeholder: true` object is returned — `renderCombinedGauge` draws
 * it as a fully-dimmed rail with a `~--→--` marker so the user sees
 * the affordance exists and knows data is still warming up.
 *
 * Prefers 5h if tied.
 */
function pickPrimaryWindow(advisory) {
  const fh = advisory?.fiveHour;
  const sd = advisory?.sevenDay;
  if (!fh && !sd) {
    return { label: '5h', current: 0, projected: 0, level: 'ok', placeholder: true };
  }
  const fhP = fh?.projected ?? -1;
  const sdP = sd?.projected ?? -1;
  if (fhP >= sdP && fh) return { ...fh, label: '5h' };
  if (sd) return { ...sd, label: '7d' };
  return { ...fh, label: '5h' };
}

/**
 * Combined gauge showing current, projected, and reset anchor.
 *   ▕████▓▓░───┤78┤░░░▏ 62→78
 * Segments:
 *   █  = consumed now  (filled, colored by level)
 *   ▓  = projected delta to reset
 *   ░  = headroom remaining
 *   ┤NN┤ = reset anchor at projection position, inverted video
 *
 * Width: 16 filled-characters for the rail. Falls back cleanly when
 * projection < current.
 */
function renderCombinedGauge(w) {
  const width = 16;

  // Placeholder rail — visible affordance when no projection yet.
  // Reads as "forecasting is loading" rather than "forecasting is broken".
  if (w.placeholder) {
    const rail = dim('─'.repeat(width));
    const endcapOpen = dim('▕');
    const endcapClose = dim('▏');
    const marker = dim('~--→--');
    return `${dim(w.label)} ${endcapOpen}${rail}${endcapClose} ${marker}`;
  }

  const color = LEVEL_COLOR[w.level] ?? dim;
  const curPct = Math.max(0, Math.min(100, (w.current ?? 0)));
  const projPct = Math.max(curPct, Math.min(100, (w.projected ?? curPct / 100) * 100));
  const peak = renderPeakGlyph(w);

  const curCells  = Math.round((curPct  / 100) * width);
  const projCells = Math.round((projPct / 100) * width);
  const deltaCells = Math.max(0, projCells - curCells);
  const tailCells  = Math.max(0, width - curCells - deltaCells);

  const bar =
    `${color('█'.repeat(curCells))}` +
    `${yellow('▓'.repeat(deltaCells))}` +
    `${dim('─'.repeat(tailCells))}`;

  const projLabel = `${Math.round(projPct)}`;
  const endcapOpen = dim('▕');
  const endcapClose = dim('▏');

  // Put the projected % marker inline at the end of the filled portion
  const marker = dim(`${Math.round(curPct)}→${projLabel}`);
  return `${cyan(w.label)} ${endcapOpen}${bar}${endcapClose} ${marker}${peak}`;
}

/**
 * Peak-hour glyph. Lit (yellow ⚡) when the peak window is active and
 * the projection is already applying the multiplier; dim when peak hours
 * are merely upcoming inside the remaining window (≥10%). Matches the
 * encoding on the Usage line so the two render the same meaning.
 */
function renderPeakGlyph(w) {
  if (w.peakActive) return ` ${yellow('⚡')}`;
  if (w.peakFraction >= 0.10 && w.peakMultiplier > 1) return ` ${dim('⚡')}`;
  return '';
}

