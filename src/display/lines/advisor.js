/**
 * Advisor line — single-glance answer to "am I ok".
 *
 * New in v2.0: combined gauge showing current position + projected
 * consumption for the most-pressing window, with a burn-trend arrow
 * derived from recent history and the usual recommendation glyph.
 *
 * Layout (wide):
 *   Advisor 5h ▕██▓▓░───┤78┤░░░▏ 62→78 │ burn 314t/m ↗ │ ▲ safe
 *   Advisor 7d ▕█████▓──────────▏ 38→52 │ burn 88t/m → │ ▲ safe
 *
 * Narrow: drops the gauge, keeps recommendation + trend.
 * Anomaly alerts still override everything (critical first, warn next).
 */
import { dim, green, yellow, red, cyan, RESET } from '../colors.js';
import { padLabel } from '../format.js';
import { readJsonl } from '../../data/jsonl.js';
import { HISTORY_FILE } from '../../data/paths.js';

const SEP = ` ${dim('│')} `;

const SIGNAL_CONFIG = {
  increase:  { icon: '▲', color: green,  label: 'safe' },
  nominal:   { icon: '──', color: dim,    label: 'nominal' },
  reduce:    { icon: '▼', color: yellow, label: 'caution' },
  throttle:  { icon: '⚠', color: red,    label: 'throttle' },
  limit_hit: { icon: '⛔', color: red,    label: 'limit hit' },
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

  // Anomaly priority
  const anomalies = ctx.anomalies ?? [];
  const critical = anomalies.find(a => a.severity === 'critical');
  if (critical) {
    return `${dim(label)} ${red(`⚠ ALERT: ${critical.message}`)}`;
  }
  const warn = anomalies.find(a => a.severity === 'warn' || !a.severity);
  if (warn && (!ctx.advisory || ctx.advisory.signal === 'nominal' || ctx.advisory.signal === 'increase')) {
    const extra = anomalies.length > 1 ? dim(` +${anomalies.length - 1} more`) : '';
    return `${dim(label)} ${yellow(`△ ${warn.message}`)}${extra}`;
  }

  // Normal advisory
  const advisory = ctx.advisory;
  if (!advisory) return `${dim(label)} ${dim('── no data')}`;

  const config = SIGNAL_CONFIG[advisory.signal] ?? SIGNAL_CONFIG.nominal;
  const recBadge = config.color(`${config.icon} ${config.label}`);

  // Pick the most-pressing window (higher of the two projections).
  const primaryWindow = pickPrimaryWindow(advisory);

  const parts = [];
  if (primaryWindow && !narrow) {
    parts.push(renderCombinedGauge(primaryWindow));
  }

  // Burn with trend arrow
  const burnRate = Math.round(ctx.tokenStats?.burnRate ?? 0);
  const arrow = burnTrendArrow(ctx.sessionId ?? null);
  if (burnRate > 0) {
    const burnColor = burnRate > 1000 ? red
                    : burnRate > 200  ? yellow
                    : green;
    parts.push(`${dim('burn')} ${burnColor(`${burnRate}t/m`)} ${arrow}`);
  }

  parts.push(recBadge);
  return `${dim(label)} ${parts.join(SEP)}`;
}

/**
 * Return the window with the higher projected-at-reset consumption,
 * or null if neither has projection data. Prefers 5h if tied.
 */
function pickPrimaryWindow(advisory) {
  const fh = advisory.fiveHour;
  const sd = advisory.sevenDay;
  if (!fh && !sd) return null;
  const fhP = fh?.projected ?? -1;
  const sdP = sd?.projected ?? -1;
  if (fhP >= sdP && fh) return { ...fh, label: '5h' };
  if (sd) return { ...sd, label: '7d' };
  return fh ? { ...fh, label: '5h' } : null;
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
  const color = LEVEL_COLOR[w.level] ?? dim;
  const curPct = Math.max(0, Math.min(100, (w.current ?? 0)));
  const projPct = Math.max(curPct, Math.min(100, (w.projected ?? curPct / 100) * 100));

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
  return `${cyan(w.label)} ${endcapOpen}${bar}${endcapClose} ${marker}`;
}

/**
 * Return a trend arrow comparing the current session's most recent
 * burn-rate history entries. ↗ rising, → flat, ↘ falling.
 * Safe to call without a sessionId (falls back to last two entries
 * regardless of session). Always returns a single-char string.
 */
function burnTrendArrow(sessionId) {
  try {
    const rows = readJsonl(HISTORY_FILE);
    if (rows.length < 2) return dim('→');
    const scoped = sessionId
      ? rows.filter(r => r.session_id === sessionId)
      : rows;
    const source = scoped.length >= 2 ? scoped : rows;
    const tail = source.slice(-3);
    if (tail.length < 2) return dim('→');
    const first = tail[0].session_burn_rate ?? 0;
    const last = tail[tail.length - 1].session_burn_rate ?? 0;
    const delta = last - first;
    if (Math.abs(delta) < Math.max(10, first * 0.1)) return dim('→');
    return delta > 0 ? yellow('↗') : green('↘');
  } catch {
    return dim('→');
  }
}
