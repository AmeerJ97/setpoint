/**
 * Guard line — inventory-first enforcement status.
 *
 * Design matches aa-status (AppArmor) and Alertmanager conventions:
 * state counts first, activity second, never merged into one number.
 * See docs/HUD-SPEC.md for the full rationale.
 *
 * Examples:
 *   Guard  ✓17/17 held │ last:brevity 2m │ ↻4 today │ top:summarize
 *   Guard  ◐14/17 held │ ○3 skipped │ last:brevity 2m │ ↻4 today
 *   Guard  ✗ DOWN 17 unprotected — run systemctl --user start claude-quality-guard
 *
 * R:E (quality) is handled on the Tokens line now; it was a distinct
 * signal from guard enforcement and should not share the line.
 */
import { dim, green, yellow, red, cyan } from '../colors.js';
import { padLabel } from '../format.js';

const TOTAL_CATEGORIES = 17; // matches src/guard/claude-quality-guard.sh CATEGORIES
const SEP = ` ${dim('│')} `;

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderGuardLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Grd' : 'Guard', narrow);
  const guard = ctx.guardStatus;

  if (!guard || !guard.running) {
    return `${dim(label)} ${red('✗ DOWN')} ${dim(`${TOTAL_CATEGORIES} unprotected`)} ${dim('— run systemctl --user start claude-quality-guard')}`;
  }

  const skipped = guard.skippedCount ?? 0;
  const held = Math.max(0, TOTAL_CATEGORIES - skipped);
  const allHeld = skipped === 0;

  const parts = [];

  // Primary inventory — counts first.
  const glyph = allHeld ? green('✓') : yellow('◐');
  const inventory = allHeld ? green(`${held}/${TOTAL_CATEGORIES}`)
                            : yellow(`${held}/${TOTAL_CATEGORIES}`);
  parts.push(`${glyph}${inventory} ${dim('held')}`);

  // Skipped categories surfaced as a first-class state (Alertmanager
  // "silenced" analogue — not collapsed into "ok").
  if (skipped > 0) {
    parts.push(`${yellow('○')}${skipped} ${dim('skipped')}`);
  }

  // Last re-apply — the "firing" analog. Only shown if the guard has
  // actually done something today, otherwise "quiet".
  const count = guard.activationsToday ?? 0;
  if (count > 0 && guard.lastActivation && guard.lastFlag) {
    parts.push(`${dim('last:')}${cyan(guard.lastFlag)} ${dim(formatAgo(guard.lastActivation))}`);
    parts.push(`${dim('↻')}${count} ${dim('today')}`);
    // Top offender today — which flag is Anthropic reverting most often
    if (!narrow && guard.topFlag && guard.topFlag !== guard.lastFlag) {
      parts.push(`${dim('top:')}${cyan(guard.topFlag)}`);
    }
  } else {
    parts.push(dim('quiet'));
  }

  return `${dim(label)} ${parts.join(SEP)}`;
}

/** @param {Date} date */
function formatAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
