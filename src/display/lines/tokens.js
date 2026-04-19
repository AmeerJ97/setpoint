/**
 * Line 4: Tokens — in:42K  out:9.5K  cache:████░░ 69%  burn:211t/m  18calls
 * Now with cache bar visualization and wider spacing.
 */
import { cyan, dim, green, yellow, red, getCacheColor, getBurnColor, coloredBar, RESET } from '../colors.js';

const SEP = ` ${dim('│')} `;
import { formatTokens, padLabel } from '../format.js';
import { calculateCost, formatCost } from '../../analytics/cost.js';
import {
  RE_RATIO_HEALTHY,
  RE_RATIO_WARN,
  countReadEdits,
  calculateRatio,
} from '../../anomaly/constants.js';
import { sparkline } from '../sparkline.js';

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderTokensLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Tok' : 'Tokens', narrow);
  const stats = ctx.tokenStats;

  if (!stats) {
    return `${dim(label)} ${dim('in:--  out:--  cache:--%  burn:--')}`;
  }

  const inTok = formatTokens(stats.totalInput ?? 0);
  const outTok = formatTokens(stats.totalOutput ?? 0);

  // Cache efficiency with mini bar
  const cacheCreate = stats.totalCacheCreate ?? 0;
  const cacheRead = stats.totalCacheRead ?? 0;
  const cacheTotal = cacheCreate + cacheRead;
  const cachePercent = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;
  const cacheColor = getCacheColor(cachePercent);
  const cacheBar = coloredBar(cachePercent, narrow ? 3 : 5, getCacheColor);

  // Burn rate
  const burnRate = stats.burnRate ?? 0;
  const burnColor = getBurnColor(burnRate);

  const apiCalls = stats.apiCalls ?? 0;

  // Session cost estimate
  const modelName = ctx.stdin?.model?.id ?? ctx.stdin?.model?.display_name;
  const cost = calculateCost(stats, modelName);

  // Per-turn sparkline (last ~8 assistant turns, output tokens each).
  // Single-glance "is this session burning hot right now?" signal.
  const turns = Array.isArray(stats.recentTurnsOutput) ? stats.recentTurnsOutput : [];
  const sparkStr = turns.length >= 2
    ? dim('⎡') + sparkline(turns, narrow ? 5 : 8) + dim('⎤')
    : '';

  const primary = [
    cyan(`in:${inTok}`),
    cyan(`out:${outTok}`),
    ...(sparkStr ? [sparkStr] : []),
    `cache:${cacheBar} ${cacheColor}${cachePercent}%${RESET}`,
  ];

  const secondary = [
    `${burnColor}burn:${Math.round(burnRate)}t/m${RESET}`,
    dim(`${apiCalls}calls`),
  ];

  // Session cost
  if (cost > 0) secondary.push(cyan(formatCost(cost)));

  // RTK savings indicator
  const rtk = ctx.rtkStats;
  if (rtk && rtk.totalSaved > 0) {
    const pct = Math.round(rtk.avgSavingsPct);
    const savedStr = formatTokens(rtk.totalSaved);
    const rtkColor = pct >= 80 ? green : pct >= 50 ? yellow : red;
    secondary.push(rtkColor(narrow ? `rtk:${pct}%` : `rtk:${savedStr}↓${pct}%`));
  }

  // Read:Edit quality badge — moved here from the Guard line. Belongs
  // with the other token-level quality signals; has nothing to do with
  // GrowthBook enforcement state.
  const re = deriveReadEditRatio(ctx);
  if (re) secondary.push(re);

  return `${dim(label)} ${primary.join('  ')}${SEP}${secondary.join('  ')}`;
}

/**
 * Compute the R:E badge from the anomaly-detector payload (preferred,
 * since it uses the same snapshot the anomaly rules ran against) or
 * fall back to the raw toolCounts on the context.
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string|null}
 */
function deriveReadEditRatio(ctx) {
  const reAnomaly = ctx.anomalies?.find(a => a?.ratio !== undefined);
  const toolCounts = ctx.toolCounts ?? {};
  let reads, edits, ratio;
  if (reAnomaly) {
    reads = reAnomaly.reads; edits = reAnomaly.edits; ratio = reAnomaly.ratio;
  } else {
    const c = countReadEdits(toolCounts);
    reads = c.reads; edits = c.edits; ratio = calculateRatio(reads, edits);
  }
  if (reads <= 0 && edits <= 0) return null;

  const ratioStr = Number.isFinite(ratio) ? ratio.toFixed(1) : '\u221e';
  const colorFn = ratio >= RE_RATIO_HEALTHY ? green
                : ratio >= RE_RATIO_WARN    ? yellow
                : red;
  return `${cyan('R:E')} ${colorFn(ratioStr)} ${dim(`(${reads}r/${edits}e)`)}`;
}
