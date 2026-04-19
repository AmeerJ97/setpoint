/**
 * Line 1: Model — [Opus 4.6 medium] claude-hud git:(main*) │ ⏱ 23m
 */
import { getModelName, getProviderLabel } from '../../data/stdin.js';
import { cyan, yellow, magenta, dim, red, green, getEffortColor, RESET } from '../colors.js';
import { padLabel } from '../format.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SEP = ` ${dim('│')} `;

function readConfig() {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const claudeJson = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
    return {
      effort: settings.effortLevel || 'default',
      teammate: claudeJson.teammateDefaultModel || 'opus',
    };
  } catch { return { effort: '?', teammate: '?' }; }
}

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderModelLine(ctx) {
  const narrow = ctx.narrow;
  const primary = [];
  const secondary = [];
  const cfg = readConfig();

  // Main model + effort badge
  const model = getModelName(ctx.stdin);
  const provider = getProviderLabel(ctx.stdin);
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const qualifier = provider ?? (hasApiKey ? red('API') : null);
  const effortColor = getEffortColor(cfg.effort);
  const effortTag = `${effortColor}${cfg.effort}${RESET}`;
  const modelCore = qualifier ? `${model}|${qualifier}` : model;
  primary.push(cyan(`[${modelCore} ${RESET}${effortTag}${cyan(']')}`));

  // Project directory
  if (ctx.stdin.cwd) {
    const segments = ctx.stdin.cwd.split(/[/\\]/).filter(Boolean);
    const projectPath = segments.length > 0 ? segments.slice(-1)[0] : '/';
    primary.push(yellow(projectPath));
  }

  // Git status
  if (ctx.gitStatus) {
    const branch = ctx.gitStatus.branch + (ctx.gitStatus.isDirty ? '*' : '');
    primary.push(`${magenta('git:(')}${cyan(branch)}${magenta(')')}`);
  }

  // Session duration (secondary)
  if (ctx.sessionDuration) {
    secondary.push(dim('⏱ ' + ctx.sessionDuration));
  }

  const left = primary.join(' ');
  const right = secondary.join('  ');
  return `${dim(padLabel('Model', narrow))} ${right ? `${left}${SEP}${right}` : left}`;
}
