/**
 * Line 6: Env — main:medium | sub:sonnet | 13r 7h 2md | UNCOMP
 */
import { dim, getEffortColor, green, red, yellow, cyan, RESET } from '../colors.js';
import { padLabel } from '../format.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function readTeammateModel() {
  try {
    const d = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    return d.teammateDefaultModel || 'opus';
  } catch { return '?'; }
}

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderEnvLine(ctx) {
  const parts = [];

  // Main thread effort — use ctx.effort which comes from detectEffort() in the main renderer
  // ctx.effort should be 'low', 'medium', or 'high' — NOT a model name string
  let effort = ctx.effort ?? 'unknown';
  // Sanitize: if effort somehow contains non-effort text, fall back to reading settings.json
  if (!['low', 'medium', 'high', 'default'].includes(effort)) {
    try {
      const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
      effort = settings.effortLevel || 'default';
    } catch {
      effort = '?';
    }
  }
  const effortColor = getEffortColor(effort);
  parts.push(`${cyan('main')}:${effortColor}${effort}${RESET}`);

  // Subagent model
  const subModel = readTeammateModel();
  const subColor = subModel === 'opus' ? yellow : subModel === 'sonnet' ? green : dim;
  parts.push(`${cyan('sub')}:${subColor(subModel)}${RESET}`);

  // Config counts
  const counts = [];
  if (ctx.rulesCount > 0) counts.push(`${ctx.rulesCount}r`);
  if (ctx.hooksCount > 0) counts.push(`${ctx.hooksCount}h`);
  if (ctx.claudeMdCount > 0) counts.push(`${ctx.claudeMdCount}md`);
  if (counts.length > 0) {
    parts.push(dim(counts.join(' ')));
  }

  // Compression indicator
  if (ctx.isCompressed) {
    parts.push(red('COMP'));
  } else {
    parts.push(green('UNCOMP'));
  }

  // Concurrent-session counter. Only surface when >1 (no clutter on
  // single-session use). Yellow because N sessions share one account
  // quota, which the user should be aware of.
  const n = ctx.activeSessionCount ?? 1;
  if (n > 1) {
    parts.push(yellow(`⧉${n} sessions`));
  }

  return `${dim(padLabel('Env', ctx.narrow))} ${parts.join(` ${dim('|')} `)}`;
}
