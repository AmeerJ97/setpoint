/**
 * Line 3: Usage
 *
 * Max plan mode (rate_limits present):
 *   5h ▕████▓▓───┤78┤░░░▏ 62→78 2h15m │ 7d ▕█▊░░░░░░░░░░░░▏ 38% 4d12h
 *
 * API mode (rate_limits absent, ANTHROPIC_API_KEY set):
 *   API  5h: ~$1.24 ▕████░░░░░░░▏ ref:$2.80 │ 7d: ~$8.45 ref:$19.60
 *   (narrow): API  ~$1.24 (5h) │ ~$8.45 (7d)
 *
 * Both windows render as combined gauges (current + projected + headroom)
 * so the reader sees not just "where am I now" but "where will I be at
 * reset if this burn continues".
 */
import { dim, red, yellow, RESET } from '../colors.js';
import { formatResetTime, padLabel } from '../format.js';
import { combinedGauge } from '../gauge.js';
import { formatApiCost } from '../../analytics/api-cost.js';

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderUsageLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Use' : 'Usage', narrow);

  // API mode: show cost-based gauges instead of quota windows.
  if (ctx.billingSignal === 'cost-metered' || ctx.mode === 'api' || ctx.mode === 'unknown') {
    return renderApiUsageLine(ctx, label, narrow);
  }

  const usage = ctx.usageData;

  if (!usage) {
    return `${dim(label)} ${dim('5h:--%')} ${dim('│')} ${dim('7d:--%')}`;
  }

  // Hard-limit banner takes over the line when either window has
  // been fully consumed.
  if (usage.fiveHour === 100 || usage.sevenDay === 100) {
    const resetTime = usage.fiveHour === 100
      ? formatResetTime(usage.fiveHourResetAt)
      : formatResetTime(usage.sevenDayResetAt);
    const resetStr = resetTime ? ` (resets ${resetTime})` : '';
    return `${dim(label)} ${red('⚠ Limit reached')}${dim(resetStr)}`;
  }

  const advisory = ctx.advisory;
  const railWidth = narrow ? 10 : 14;

  // Pass advisory level only when it was actually derived from a
  // real projection (rates.js returns null when resetAt is missing,
  // advisor.js then fills a placeholder with level='ok' — which
  // produces false green bars at 62%+). When that placeholder is in
  // play, hand undefined to the gauge so it derives level from the
  // actual current%.
  const fhLevel = advisory?.fiveHour?.current != null ? advisory.fiveHour.level : undefined;
  const sdLevel = advisory?.sevenDay?.current != null ? advisory.sevenDay.level : undefined;

  const five = formatWindow('5h', usage.fiveHour, usage.fiveHourResetAt,
    advisory?.fiveHour?.projected, fhLevel, railWidth, advisory?.fiveHour);
  const seven = formatWindow('7d', usage.sevenDay, usage.sevenDayResetAt,
    advisory?.sevenDay?.projected, sdLevel, railWidth, advisory?.sevenDay);

  return `${dim(label)} ${five} ${dim('│')} ${seven}`;
}

// ---------------------------------------------------------------------------
// API mode renderer
// ---------------------------------------------------------------------------

function renderApiUsageLine(ctx, label, narrow) {
  const refs = ctx.apiWindowRefs;
  const isVertex = ctx.runtimeMode?.backend === 'vertex-ai' || ctx.authProvider === 'vertex';

  if (!refs) {
    // apiWindowRefs not computed yet (unlikely, but guard it)
    return `${dim(label)} ${dim('computing...')}`;
  }

  const { sessionCostUsd, ref5hCostUsd, ref7dCostUsd,
          sessionCostPct5h, sessionCostPct7d,
          level5h, level7d, dataMaturity,
          sessionCostAuthority, pricingKnown } = refs;

  if (isVertex) {
    return renderVertexUsageLine(ctx, label, narrow);
  }

  const costStr = pricingKnown === false
    ? yellow('price:unknown')
    : (sessionCostAuthority === 'statusline-cost'
      ? formatApiCostInline(sessionCostUsd, false)
      : formatApiCost(sessionCostUsd));
  const sourceTag = sessionCostAuthority === 'statusline-cost' ? ` ${dim('actual')}` : '';

  if (narrow) {
    // Narrow: drop gauge + ref, show live cost with window labels
    const c5h = ref5hCostUsd
      ? `${costStr}${sourceTag} ${dim('(5h)')}`
      : `${costStr}${sourceTag} ${dim('(5h)')}`;
    const c7d = ref7dCostUsd
      ? `${formatApiCost(ref7dCostUsd)} ${dim('(7d)')}`
      : dim('7d:warming');
    return `${dim(label)} ${c5h} ${dim('│')} ${c7d}`;
  }

  // Wide: show cost gauge against historical reference
  const five = formatApiWindow('5h', sessionCostUsd, ref5hCostUsd,
    sessionCostPct5h, level5h, 11, costStr);
  const seven = formatApiWindow('7d', sessionCostUsd, ref7dCostUsd,
    sessionCostPct7d, level7d, 11, costStr);

  const maturity = dataMaturity?.state;
  const maturitySuffix = maturity === 'local_reference'
    ? ''
    : ` ${dim(maturity === 'cold_start' ? '(no history yet)' : '(warming history)')}`;

  return `${dim(label)} ${five}${sourceTag} ${dim('│')} ${seven}${maturitySuffix}`;
}

function renderVertexUsageLine(ctx, label, narrow) {
  const telemetry = ctx.vertexTelemetry;
  const telemetryAuthority = telemetry?.telemetryAuthority ?? ctx.runtimeMode?.telemetryAuthority ?? 'local-synthetic';
  const apiBacked = telemetryAuthority === 'vertex-api';
  const metricsBacked = telemetryAuthority === 'vertex-metrics-estimate';
  const five = telemetry?.fiveHour;
  const seven = telemetry?.sevenDay;
  const fiveCost = Number.isFinite(five?.costUsd) && five.costUsd >= 0 ? five.costUsd : null;
  const sevenCost = Number.isFinite(seven?.costUsd) && seven.costUsd >= 0 ? seven.costUsd : null;
  const costStr = apiBacked && (fiveCost != null || sevenCost != null)
    ? formatApiCostInline(fiveCost ?? sevenCost, false)
    : (metricsBacked ? yellow('metrics') : red('telem:miss'));

  const fiveStr = apiBacked || metricsBacked
    ? (five ? `5h:${fmtTokens(five.totalTokens)}t` : '5h:--')
    : '5h:--';
  const sevenStr = apiBacked || metricsBacked
    ? (seven ? `7d:${fmtTokens(seven.totalTokens)}t` : '7d:--')
    : '7d:--';
  const cache = apiBacked || metricsBacked
    ? (five ? `cache:${fmtTokens(five.cacheCreateTokens + five.cacheReadTokens)}t` : 'cache:--')
    : 'cache:--';
  const quota = telemetry?.latestQuotaEvent
    ? ` ${red('RESOURCE_EXHAUSTED')}`
    : '';
  const meteringTag = apiBacked ? dim('api') : (metricsBacked ? yellow('metrics') : red('missing'));

  if (narrow) {
    return `${dim(label)} ${costStr} ${meteringTag} ${dim('│')} ${dim(fiveStr)}${quota}`;
  }

  return `${dim(label)} ${costStr} ${meteringTag} ${dim('│')} ${dim(fiveStr)} ${dim('│')} ${dim(sevenStr)} ${dim('│')} ${dim(cache)}${quota}`;
}

/**
 * Format a single API mode window segment.
 * e.g. "5h: ~$1.24 ▕████░░░░░░░▏ ref:$2.80"
 *       "5h: ~$1.24" (when no ref)
 */
function formatApiWindow(name, sessionCostUsd, refCostUsd, pct, level, railWidth, costStrOverride = null) {
  const costStr = costStrOverride ?? formatApiCost(sessionCostUsd);
  const nameColored = dim(`${name}:`);

  if (!refCostUsd) {
    // No reference data — just show the live cost, dimmed
    return `${nameColored} ${costStr} ${dim('warming')}`;
  }

  // Bar: session cost as % of ref5h
  const color = levelToColor(level);
  const filled = Math.round(Math.min(pct, 100) / 100 * railWidth);
  const empty = Math.max(0, railWidth - filled);
  const bar = `${color}${'█'.repeat(filled)}${dim('░'.repeat(empty))}${RESET}`;
  const gauge = `▕${bar}▏`;

  const refStr = dim(`ref:${formatApiCost(refCostUsd).replace('~', '')}`);

  return `${nameColored} ${costStr} ${gauge} ${refStr}`;
}

function levelToColor(level) {
  if (level === 'critical') return '\x1b[31m'; // red
  if (level === 'tight')    return '\x1b[33m'; // yellow
  if (level === 'watch')    return '\x1b[33m'; // yellow
  return '\x1b[32m';                           // green
}

function formatApiCostInline(cost, estimated = false) {
  if (!Number.isFinite(cost) || cost < 0) return '--';
  if (cost === 0) return '$0.00';
  const prefix = estimated ? '~' : '';
  if (cost >= 10) return `${prefix}$${cost.toFixed(0)}`;
  if (cost >= 1) return `${prefix}$${cost.toFixed(1)}`;
  if (cost >= 0.01) return `${prefix}$${cost.toFixed(2)}`;
  return '<$0.01';
}

// ---------------------------------------------------------------------------
// Max plan window formatter (unchanged)
// ---------------------------------------------------------------------------

function formatWindow(name, current, resetAt, projected, level, railWidth, detail) {
  if (current === null || current === undefined) {
    return `${dim(`${name}:--%`)}`;
  }
  const gauge = combinedGauge({
    label: name,
    current,
    projected,
    level,  // undefined → combinedGauge derives from `current` via quota thresholds
    width: railWidth,
  });
  const reset = formatResetTime(resetAt);
  const resetStr = reset ? ` ${dim(reset)}` : '';
  // Peak-hour multiplier indicator. `⚡` lit when current local time is in
  // the peak window; dimmed when peak hours are upcoming inside the window.
  let peakStr = '';
  if (detail?.peakActive) {
    peakStr = ` ${yellow('⚡')}`;
  } else if (detail && detail.peakFraction >= 0.10 && detail.peakMultiplier > 1) {
    peakStr = ` ${dim('⚡')}`;
  }
  return `${gauge}${resetStr}${peakStr}`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toString();
}
