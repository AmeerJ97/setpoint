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
import { dim, green, yellow, red, cyan, magenta, bold, RESET } from '../colors.js';
import { padLabel, padVisualEnd } from '../format.js';
import { truncateToWidth } from '../text.js';
import { pickSalienceSegment } from './advisor-salience.js';

// FSM badge glyphs — icon-only, always. Bold for anything past SCOUTING
// so the eye catches state changes in peripheral vision; dim for the
// neutral cold-start state so it doesn't compete with the recommendation.
const FSM_BADGES = {
  SCOUTING:   { icon: '◐', color: dim,     bold: false },
  EXECUTING:  { icon: '▶', color: green,   bold: true  },
  DEBUGGING:  { icon: '⚙', color: yellow,  bold: true  },
  THRASHING:  { icon: '⚠', color: red,     bold: true  },
  AWAIT_USER: { icon: '⏸', color: magenta, bold: true  },
};

// Fixed column widths for two-row alignment AND cross-line grid:
//   gauge  = 32 cols → matches Context / Tokens / Guard `PRIMARY_COL_WIDTH`
//            so the first `│` after the primary column stacks vertically
//            across every line on the HUD.
//   tte    = "TTE 9d23h" ≈ 9 visual cols
//   conf   = "conf:high" = 9 visual cols
const COL_GAUGE = 32;
const COL_TTE   = 9;
const COL_CONF  = 9;

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

  // API mode: replace TTE / quota gauge with cost-velocity display.
  if (ctx.billingSignal === 'cost-metered' || ctx.mode === 'api' || ctx.mode === 'unknown') {
    return renderApiAdvisorLine(ctx, label, narrow, advisory, warn);
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
  const fsmBadge = renderFsmBadge(advisory.fsm);
  const rawAction = warmingUp
    ? dim(`~ ${text}`)
    : renderActionBadge(config, text);
  const recBadge = fsmBadge ? `${fsmBadge} ${rawAction}` : rawAction;

  // Narrow mode — compact single row, same as before.
  if (narrow) {
    const parts = [recBadge];
    if (warn) {
      const extra = anomalies.filter(a => a.severity === 'warn' || !a.severity).length - 1;
      const suffix = extra > 0 ? dim(` +${extra}`) : '';
      parts.push(truncateToWidth(`${yellow(`△ ${warn.message}`)}${suffix}`, 40));
    }
    return `${dim(label)} ${parts.join(SEP)}`;
  }

  // Wide mode — two rows, columns aligned between them:
  //   Advisor 5h ▕██▓─────▏ 62→78 │ TTE 6h    │ conf:med  │ ▼ /compact │ ⚡ burn 3× P50
  //           7d ▕█████▓──▏ 38→52 │ TTE --    │ conf:high │ ▲ on track │ △ reversals 27/1k
  // The action badge rides with the primary (more-pressing) window on
  // row 1; row 2 shows the other window + trailing salience / warn
  // badges so the advisor content stays at 2 rows even when heavily
  // decorated.
  const primaryWindow = pickPrimaryWindow(advisory);
  const secondaryWindow = pickSecondaryWindow(advisory, primaryWindow);

  const row1Parts = [
    padVisualEnd(renderCombinedGauge(primaryWindow), COL_GAUGE),
    padVisualEnd(renderTte(primaryWindow), COL_TTE),
    padVisualEnd(renderConfidence(advisory.confidence), COL_CONF),
    recBadge,
  ];
  const salience = pickSalienceSegment(advisory, primaryWindow);
  if (salience) row1Parts.push(salience);

  // Auto-effort swap trailer — only on the render that applied the
  // swap. Uses the cyan `· auto:from→to` form so the user can see a
  // swap just happened; absent otherwise.
  if (ctx.effortSwap) {
    row1Parts.push(cyan(`· auto:${ctx.effortSwap.from}→${ctx.effortSwap.to}`));
  }

  const row2Parts = [
    padVisualEnd(renderCombinedGauge(secondaryWindow), COL_GAUGE),
    padVisualEnd(renderTte(secondaryWindow), COL_TTE),
    padVisualEnd(renderConfidence(advisory.confidence), COL_CONF),
  ];

  // Warn anomaly lives on row 2 so it never competes with the primary
  // recommendation on row 1.
  if (warn) {
    const extra = anomalies.filter(a => a.severity === 'warn' || !a.severity).length - 1;
    const suffix = extra > 0 ? dim(` +${extra}`) : '';
    const badge = `${yellow(`△ ${warn.message}`)}${suffix}`;
    row2Parts.push(truncateToWidth(badge, 40));
  }

  const row1 = `${dim(label)} ${row1Parts.join(SEP)}`;
  // Row 2: pad the label column with spaces so the gauge column of row
  // 2 lines up with row 1's gauge column.
  const labelPad = ' '.repeat(label.length);
  const row2 = `${labelPad} ${row2Parts.join(SEP)}`;
  return `${row1}\n${row2}`;
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
 * FSM state badge — always icon-only. Returns an empty string when the
 * advisor output has no FSM slot (e.g., FSM failed silently inside the
 * renderer's try/catch) so the line degrades cleanly.
 *
 * @param {{state?: string}|undefined|null} fsm
 * @returns {string}
 */
function renderFsmBadge(fsm) {
  if (!fsm || !fsm.state) return '';
  const spec = FSM_BADGES[fsm.state];
  if (!spec) return '';
  const colored = spec.color(spec.icon);
  return spec.bold ? bold(colored) : colored;
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
/**
 * Return the window that should live on row 2 — always the one not
 * chosen as primary. Falls back to a placeholder so row 2 renders a
 * dimmed rail rather than vanishing, which would visually collapse
 * the advisor back to 1 row and mask loading state.
 */
function pickSecondaryWindow(advisory, primary) {
  const fh = advisory?.fiveHour;
  const sd = advisory?.sevenDay;
  const primaryLabel = primary?.label;
  if (primaryLabel === '5h' && sd) return { ...sd, label: '7d' };
  if (primaryLabel === '7d' && fh) return { ...fh, label: '5h' };
  const otherLabel = primaryLabel === '5h' ? '7d' : '5h';
  return { label: otherLabel, current: 0, projected: 0, level: 'ok', placeholder: true };
}

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

// ---------------------------------------------------------------------------
// API mode advisor renderer
// ---------------------------------------------------------------------------

/**
 * In API mode there are no 5h/7d rolling windows to project against.
 * Instead we show:
 *   Row 1: API · $/h burn rate vs historical baseline · action badge
 *   Row 2 (wide): session total cost · 7d cost · confidence
 *
 * Wide example:
 *   Advisor API  $2.31/h  ▼ burn 2×P50 — switch to Sonnet │ conf:low
 *           API  session:~$0.82 │ 7d:~$18.40 │ cost mode: no quota data
 *
 * Narrow example:
 *   Adv  API  $2.31/h  ▼ burn high
 *
 * @param {import('../renderer.js').RenderContext} ctx
 * @param {string} label
 * @param {boolean} narrow
 * @param {object} advisory
 * @param {object|null} warn
 * @returns {string}
 */
function renderApiAdvisorLine(ctx, label, narrow, advisory, warn) {
  const refs = ctx.apiWindowRefs;
  const isVertex = ctx.runtimeMode?.backend === 'vertex-ai' || ctx.authProvider === 'vertex';
  const conf = advisory.confidence ?? 'low';
  const confStr = `conf:${conf}`;

  // $/h burn rate
  const durationMin = ctx.tokenStats?.durationMin ?? 0;
  const sessionCostUsd = refs?.sessionCostUsd ?? 0;
  const telemetryAuthority = ctx.vertexTelemetry?.telemetryAuthority ?? ctx.runtimeMode?.telemetryAuthority;
  const apiBacked = !isVertex || telemetryAuthority === 'vertex-api';
  const metricsBacked = isVertex && telemetryAuthority === 'vertex-metrics-estimate';
  const vertexApiMissing = isVertex && !apiBacked && !metricsBacked;
  const vertex5hCost = Number.isFinite(ctx.vertexTelemetry?.fiveHour?.costUsd) && ctx.vertexTelemetry.fiveHour.costUsd >= 0
    ? ctx.vertexTelemetry.fiveHour.costUsd
    : null;
  const vertex7dCost = Number.isFinite(ctx.vertexTelemetry?.sevenDay?.costUsd) && ctx.vertexTelemetry.sevenDay.costUsd >= 0
    ? ctx.vertexTelemetry.sevenDay.costUsd
    : null;
  const costPerHour = isVertex
    ? (vertex5hCost != null
      ? (vertex5hCost / 5)
      : (vertex7dCost != null ? (vertex7dCost / (7 * 24)) : null))
    : (durationMin > 0 ? (sessionCostUsd / durationMin) * 60 : null);
  const rateStr = isVertex
    ? ((apiBacked && costPerHour != null)
      ? `${dim('$')}${costPerHour >= 1 ? costPerHour.toFixed(1) : costPerHour.toFixed(2)}${dim('/h')}`
      : (metricsBacked ? yellow('metrics only') : dim('--/h')))
    : (costPerHour != null && costPerHour > 0
      ? `${dim('$')}${costPerHour >= 1 ? costPerHour.toFixed(1) : costPerHour.toFixed(2)}${dim('/h')}`
      : dim('--/h'));

  // Burn velocity vs baseline
  const ref5h = refs?.ref5hCostUsd;
  let burnSignal = '';
  if (!isVertex && ref5h && sessionCostUsd > 0 && durationMin > 0) {
    const projectedHourly = costPerHour ?? 0;
    // What hourly rate would exhaust the 5h reference in exactly 5h?
    const refHourly = ref5h / 5;
    const ratio = refHourly > 0 ? projectedHourly / refHourly : 0;
    if (ratio >= 2.5) {
      burnSignal = ` ${red(`burn ${ratio.toFixed(1)}×ref`)}`;
    } else if (ratio >= 1.5) {
      burnSignal = ` ${yellow(`burn ${ratio.toFixed(1)}×ref`)}`;
    }
  }

  // Action badge (reuse from the normal advisory)
  const config = SIGNAL_CONFIG[advisory.signal] ?? SIGNAL_CONFIG.nominal;
  const warmingUp = advisory.confidence === 'low' && (advisory.tier ?? 'ok') === 'ok';
  const baseText = advisory.action ?? config.defaultLabel;
  const text = warmingUp ? `${baseText} — warming up` : baseText;
  const compactVertexAction = isVertex && !apiBacked
    ? renderActionBadge(config, metricsBacked ? 'use token metrics' : 'collect api-cost')
    : null;
  const rawAction = compactVertexAction ?? (warmingUp
    ? dim(`~ ${text}`)
    : renderActionBadge(config, text));
  const actionBadge = truncateToWidth(rawAction, 26);

  if (narrow) {
    const warnStr = warn && !isDuplicateVertexTelemetryWarning(warn, vertexApiMissing)
      ? `${SEP}${yellow(`△ ${warn.message}`)}`
      : '';
    return `${dim(label)} ${rateStr}${burnSignal}${SEP}${actionBadge}${warnStr}`;
  }

  // Wide: two rows
  const sessionStr = isVertex
    ? (apiBacked && vertex5hCost != null
      ? dim(`5h:${formatApiCostInline(vertex5hCost, false)}`)
      : dim(metricsBacked ? '5h:metrics-only' : '5h:--'))
    : (refs
      ? dim(`session:${formatApiCostInline(refs.sessionCostUsd, false)}`)
      : dim('session:--'));
  const ref7dStr = isVertex
    ? (apiBacked && vertex7dCost != null
      ? dim(`7d:${formatApiCostInline(vertex7dCost, false)}`)
      : dim(metricsBacked ? '7d:metrics-only' : '7d:--'))
    : (refs?.ref7dCostUsd
      ? dim(`7d:${formatApiCostInline(refs.ref7dCostUsd, false)}`)
      : dim('7d:--'));

  const row1 = `${dim(label)} ${rateStr}${burnSignal}${SEP}${actionBadge}${SEP}${dim(confStr)}`;
  const telemetry = isVertex
    ? (apiBacked
      ? dim(`billing:api ${ctx.vertexTelemetry?.dataMaturity?.state ?? 'authoritative'}`)
      : metricsBacked
        ? yellow(`billing:metrics ${ctx.vertexTelemetry?.dataMaturity?.state ?? 'metrics_reference'}`)
      : dim('billing:missing'))
    : dim('cost mode');
  const labelPad = dim(' '.repeat(padLabel('Advisor', false).length));
  const row2 = `${labelPad} ${sessionStr}${SEP}${ref7dStr}${SEP}${telemetry}`;
  const row3 = warn && !isDuplicateVertexTelemetryWarning(warn, vertexApiMissing)
    ? `${labelPad} ${truncateToWidth(yellow(`△ ${warn.message}`), 64)}`
    : null;

  return row3 ? `${row1}\n${row2}\n${row3}` : `${row1}\n${row2}`;
}

function isDuplicateVertexTelemetryWarning(warn, vertexApiMissing) {
  if (!vertexApiMissing || !warn?.message) return false;
  return /api|telemetry|dashboard|console/i.test(warn.message);
}

/** Format a USD value for inline use (no `~` prefix, compact) */
function formatApiCostInline(cost, estimated = false) {
  if (!Number.isFinite(cost) || cost < 0) return '--';
  if (cost === 0) return '$0.00';
  const prefix = estimated ? '~' : '';
  if (cost >= 10)   return `${prefix}$${cost.toFixed(0)}`;
  if (cost >= 1)    return `${prefix}$${cost.toFixed(1)}`;
  if (cost >= 0.01) return `${prefix}$${cost.toFixed(2)}`;
  return '<$0.01';
}
