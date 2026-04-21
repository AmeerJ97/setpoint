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
  // Env has three semantic groups: models (main + sub), config counts,
  // state glyphs (compression + concurrent sessions). Inside a group
  // items join with a soft `·` so the eye reads them as related; groups
  // are separated by the heavier `│` that matches other lines.
  const SOFT = ` ${dim('·')} `;

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
  const mainSeg = `${cyan('main')}:${effortColor}${effort}${RESET}`;

  // Subagent model
  const subModel = readTeammateModel();
  const subColor = subModel === 'opus' ? yellow : subModel === 'sonnet' ? green : dim;
  const subSeg = `${cyan('sub')}:${subColor(subModel)}${RESET}`;
  const modelsGroup = [mainSeg, subSeg].join(SOFT);

  // Config counts — single dim chunk, no internal separators needed.
  const counts = [];
  if (ctx.rulesCount > 0) counts.push(`${ctx.rulesCount}r`);
  if (ctx.hooksCount > 0) counts.push(`${ctx.hooksCount}h`);
  if (ctx.claudeMdCount > 0) counts.push(`${ctx.claudeMdCount}md`);
  const countsGroup = counts.length > 0 ? dim(counts.join(' ')) : null;

  // State glyphs group: compression + concurrent sessions ride together.
  const compSeg = ctx.isCompressed ? red('COMP') : green('UNCOMP');
  const n = ctx.activeSessionCount ?? 1;
  const sessionsSeg = n > 1 ? yellow(`⧉${n} sessions`) : null;
  const stateGroup = sessionsSeg ? [compSeg, sessionsSeg].join(SOFT) : compSeg;

  const parts = [modelsGroup];
  if (countsGroup) parts.push(countsGroup);
  parts.push(stateGroup);

  // Daemon staleness affordance — when the analytics daemon hasn't
  // refreshed this session's cache in > 2 × poll interval, the token
  // numbers on the HUD are up to N seconds old. Show the age so the
  // reader knows reads aren't fresh; absent when daemon is healthy.
  const staleSec = ctx.daemonStaleSec;
  if (Number.isFinite(staleSec) && staleSec !== null) {
    parts.push(dim(`· stale ${staleSec}s`));
  }

  return `${dim(padLabel('Env', ctx.narrow))} ${parts.join(` ${dim('│')} `)}`;
}
