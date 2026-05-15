/**
 * Line 1: Model — [Opus 4.7 medium] claude-ops git:(main*) │ ⏱ 23m
 */
import { getModelName } from '../../data/stdin.js';
import { authProviderTier, authProviderTierGlyph, runtimeBackendLabel } from '../../data/mode.js';
import { CLAUDE_JSON_PATH, getClaudeConfigDir } from '../../data/paths.js';
import { cyan, yellow, magenta, dim, red, green, getEffortColor, RESET } from '../colors.js';

/**
 * Pick the tier color for the auth-provider badge on the Model line.
 * @param {ReturnType<typeof authProviderTier>} tier
 * @returns {(s: string) => string}
 */
function tierColor(tier) {
  switch (tier) {
    case 'vertex': return green;     // cloud / OAuth — distinct from "direct"
    case 'anthropic': return red;    // direct Anthropic (any auth flavor)
    case 'gateway': return magenta;  // local proxy
    case 'bedrock': return yellow;   // AWS
    case 'foundry': return yellow;   // Azure
    default: return dim;
  }
}
import { padLabel } from '../format.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SEP = ` ${dim('│')} `;

function readConfig() {
  try {
    const settings = JSON.parse(readFileSync(join(getClaudeConfigDir(), 'settings.json'), 'utf8'));
    const claudeJson = JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf8'));
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

  // Main backend + model + effort badge. Provider identity belongs here and
  // nowhere else in the HUD, so Usage and Advisor can focus on telemetry.
  const model = getModelName(ctx.stdin);
  const tier = authProviderTier(ctx.authProvider);              // coarse: vertex|anthropic|gateway|bedrock|foundry|null
  const tierGlyph = authProviderTierGlyph(tier);                // single-char leading marker
  const paint = tierColor(tier);
  const backendBadge = runtimeBackendLabel(ctx.runtimeMode ?? {
    authProvider: ctx.authProvider,
    billingSignal: ctx.billingSignal,
  });
  const effort = ctx.effort ?? cfg.effort;
  const effortColor = getEffortColor(effort);
  const effortTag = `${effortColor}${effort}${RESET}`;
  const glyphPrefix = tierGlyph ? `${paint(tierGlyph)} ` : '';
  primary.push(`${glyphPrefix}${paint(backendBadge)} ${cyan(`[${model} ${RESET}${effortTag}${cyan(']')}`)}`);

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
  if (ctx.stdin.agent?.name) {
    secondary.push(dim(`agent:${ctx.stdin.agent.name}`));
  }
  const wt = ctx.stdin.worktree?.name ?? ctx.stdin.workspace?.git_worktree;
  if (wt) {
    secondary.push(dim(`wt:${wt}`));
  }

  const left = primary.join(' ');
  const right = secondary.join('  ');
  return `${dim(padLabel('Model', narrow))} ${right ? `${left}${SEP}${right}` : left}`;
}
