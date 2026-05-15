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
import { octantBar, getContextColor, RESET, dim } from '../colors.js';
import { getAdaptiveBarWidth } from '../terminal.js';
import { formatTokens, padLabel, padVisualEnd } from '../format.js';

// Shared grid anchor: the first `│` separator on the primary
// content lines (Context, Tokens, Guard, Advisor) stacks at the
// same visual column so the eye tracks down a single axis instead
// of drifting. 32 cols accommodates the longest natural primary
// segment (Tokens in/out/cache) without truncation.
const PRIMARY_COL_WIDTH = 32;

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

  const primary = padVisualEnd(`${bar} ${pctDisplay}  ${tokenDisplay}`, PRIMARY_COL_WIDTH);
  const secondaryParts = [];
  if (bufferedNote) secondaryParts.push(bufferedNote);
  const secondary = secondaryParts.join('  ');

  return secondary
    ? `${dim(label)} ${primary}${SEP}${secondary}`
    : `${dim(label)} ${primary}`.trimEnd();
}
