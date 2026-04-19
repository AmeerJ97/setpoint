/**
 * Line 2: Context — ████████░░░░░ 48%  (42K/200K)  in:30K cache:680K  compact:52%
 * Wider spacing, always shows token breakdown.
 */
import { getContextPercent, getBufferedPercent, getTotalTokens } from '../../data/stdin.js';
import { octantBar, getContextColor, RESET, dim, cyan } from '../colors.js';
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
  const percent = bufferedPercent;
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Ctx' : 'Context', narrow);

  const color = getContextColor(percent);
  const bar = octantBar(percent, getAdaptiveBarWidth(), getContextColor);
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

  // Compaction proximity warning
  let compactWarning = '';
  if (percent >= 90) {
    compactWarning = `  ${color}compact:${rawPercent}%${RESET}`;
  } else if (percent >= 75) {
    compactWarning = `  ${dim(`compact:${rawPercent}%`)}`;
  }

  const primary = `${bar} ${pctDisplay}  ${tokenDisplay}`;
  const secondaryParts = [];
  if (breakdown) secondaryParts.push(breakdown.trim());
  if (compactWarning) secondaryParts.push(compactWarning.trim());
  const secondary = secondaryParts.join('  ');

  return secondary
    ? `${dim(label)} ${primary}${SEP}${secondary}`
    : `${dim(label)} ${primary}`.trimEnd();
}
