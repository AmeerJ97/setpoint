/**
 * Line 5: MCPs — counts-first with per-server state glyphs.
 *
 *   MCPs 3/22 active │ ● claude-in-chrome ● perplexity ● sentry │ ○19 idle
 *   MCPs 3/22 active │ ● brave │ ✗ sentry │ ○18 idle │ ✗1 failed
 *
 * Design follows aa-status: lead with counts, then enumerate active,
 * keep idle as a summary tail. Failed servers surface in-line with
 * a red glyph so the reader can't miss them.
 */
import { dim, bold, green, red } from '../colors.js';
import { padLabel } from '../format.js';

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderMcpsLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'MCP' : 'MCPs', narrow);
  const total = ctx.mcpCount ?? 0;
  const active = ctx.activeMcps ?? [];
  const failed = ctx.healthSummary?.mcpFailures ?? 0;

  if (total === 0) return `${dim(label)} ${dim('none configured')}`;

  const inventory = `${bold(`${active.length}/${total}`)} ${dim('active')}`;
  const idle = Math.max(0, total - active.length - failed);
  const SEP = ` ${dim('│')} `;
  const parts = [inventory];

  if (active.length > 0) {
    const names = narrow
      ? active.map(n => n.slice(0, 4)).join(' ')
      : active.map(n => `${green('●')} ${n}`).join('  ');
    parts.push(names);
  }

  if (idle > 0) {
    parts.push(`${dim('○')}${idle} ${dim('idle')}`);
  }

  if (failed > 0) {
    parts.push(`${red('✗')}${failed} ${red('failed')}`);
  }

  return `${dim(label)} ${parts.join(SEP)}`;
}
