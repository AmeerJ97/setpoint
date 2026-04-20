/**
 * Line 2: Context — ████████╎░░░░ 48%  (42K/200K)  in:30K cache:680K  ⊕buf:64%
 *
 * Phase 1.3: headline % is the JSONL-derived raw value (matches what
 * /context shows and what usage-history.jsonl persists). The
 * autocompact buffer is rendered as a dim `╎` marker on the gauge and
 * a `⊕buf:N%` secondary number, so the user sees both "real now" and
 * "where compaction trips" without conflating them.
 */
import { getContextPercent, getBufferedPercent, getTotalTokens } from '../../data/stdin.js';
import { octantBar, getContextColor, RESET, dim, cyan, green, yellow, red } from '../colors.js';
import { getAdaptiveBarWidth } from '../terminal.js';
import { formatTokens, padLabel } from '../format.js';

const SEP = ` ${dim('│')} `;

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderContextLine(ctx) {
  const rawPercent = getContextPercent(ctx.stdin);
  const bufferedPercent = getBufferedPercent(ctx.stdin);
  const percent = rawPercent;
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Ctx' : 'Context', narrow);

  const color = getContextColor(percent);
  const bar = octantBar(percent, getAdaptiveBarWidth(), getContextColor, bufferedPercent);
  const pctDisplay = `${color}${percent}%${RESET}`;

  const size = ctx.stdin.context_window?.context_window_size ?? 0;
  const total = getTotalTokens(ctx.stdin);
  const tokenDisplay = size > 0
    ? dim(`(${formatTokens(total)}/${formatTokens(size)})`)
    : '';

  // Token breakdown — always show when available
  const usage = ctx.stdin.context_window?.current_usage;
  let breakdown = '';
  if (usage && !narrow) {
    const parts = [];
    const input = usage.input_tokens ?? 0;
    const cacheR = usage.cache_read_input_tokens ?? 0;
    const cacheC = usage.cache_creation_input_tokens ?? 0;
    if (input > 0) parts.push(`in:${formatTokens(input)}`);
    if (cacheR + cacheC > 0) parts.push(`cache:${formatTokens(cacheR + cacheC)}`);
    if (parts.length > 0) breakdown = '  ' + dim(parts.join(' '));
  }

  // Buffered overlay: only show when the autocompact buffer adds enough
  // to materially shift the picture (≥3 pp gap), or once raw is in the
  // warning zone where compaction is imminent.
  const bufferGap = bufferedPercent - rawPercent;
  let bufferedNote = '';
  if (bufferGap >= 3 || rawPercent >= 70) {
    const bufColor = bufferedPercent >= 90 ? color : '';
    bufferedNote = bufColor
      ? `${bufColor}⊕buf:${bufferedPercent}%${RESET}`
      : dim(`⊕buf:${bufferedPercent}%`);
  }

  // RTK savings — belongs on Context (cache-related), not Tokens (burn).
  let rtkNote = '';
  const rtk = ctx.rtkStats;
  if (rtk && rtk.totalSaved > 0 && !narrow) {
    const pct = Math.round(rtk.avgSavingsPct);
    const savedStr = formatTokens(rtk.totalSaved);
    const rtkColor = pct >= 80 ? green : pct >= 50 ? yellow : red;
    rtkNote = rtkColor(`rtk:${savedStr}↓${pct}%`);
  }

  const primary = `${bar} ${pctDisplay}  ${tokenDisplay}`;
  const secondaryParts = [];
  if (breakdown) secondaryParts.push(breakdown.trim());
  if (bufferedNote) secondaryParts.push(bufferedNote);
  if (rtkNote) secondaryParts.push(rtkNote);
  const secondary = secondaryParts.join('  ');

  return secondary
    ? `${dim(label)} ${primary}${SEP}${secondary}`
    : `${dim(label)} ${primary}`.trimEnd();
}
