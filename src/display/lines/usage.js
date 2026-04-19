/**
 * Line 3: Usage
 *   5h ▕████▓▓───┤78┤░░░▏ 62→78 2h15m │ 7d ▕█▊░░░░░░░░░░░░▏ 38% 4d12h
 *
 * Both windows render as combined gauges (current + projected + headroom)
 * so the reader sees not just "where am I now" but "where will I be at
 * reset if this burn continues".
 */
import { dim, red, yellow, green, RESET } from '../colors.js';
import { formatResetTime, padLabel } from '../format.js';
import { combinedGauge } from '../gauge.js';

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderUsageLine(ctx) {
  const usage = ctx.usageData;
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Use' : 'Usage', narrow);

  if (!usage) {
    return `${dim(label)} ${dim('5h:--%')} ${dim('|')} ${dim('7d:--%')}`;
  }

  // Hard-limit banner takes over the line when either window has
  // been fully consumed.
  if (usage.fiveHour === 100 || usage.sevenDay === 100) {
    const resetTime = usage.fiveHour === 100
      ? formatResetTime(usage.fiveHourResetAt)
      : formatResetTime(usage.sevenDayResetAt);
    const resetStr = resetTime ? ` (resets ${resetTime})` : '';
    return `${dim(label)}  ${red('⚠ Limit reached')}${dim(resetStr)}`;
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
    advisory?.fiveHour?.projected, fhLevel, railWidth);
  const seven = formatWindow('7d', usage.sevenDay, usage.sevenDayResetAt,
    advisory?.sevenDay?.projected, sdLevel, railWidth);

  return `${dim(label)} ${five} ${dim('│')} ${seven}`;
}

function formatWindow(name, current, resetAt, projected, level, railWidth) {
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
  return `${gauge}${resetStr}`;
}
