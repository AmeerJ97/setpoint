/**
 * Right column renderer — secondary metrics for each HUD line.
 * Displayed when terminal width >= 100 chars.
 * Uses sparklines and colored indicators for density.
 */
import { dim, cyan, green, yellow, red, RESET } from './colors.js';
import { formatTokens } from './format.js';
import { calculateCost, formatCost } from '../analytics/cost.js';
import { miniBar } from './sparkline.js';

/**
 * Generate right-column content for each of the 8 lines.
 * @param {import('./renderer.js').RenderContext} ctx
 * @returns {string[]} array of 8 right-column strings
 */
export function renderRightColumns(ctx) {
  return [
    rightModel(ctx),
    rightContext(ctx),
    rightUsage(ctx),
    rightTokens(ctx),
    rightEnv(ctx),
    rightMcps(ctx),
    rightGuard(ctx),
    rightAdvisor(ctx),
  ];
}

// Note: 8 entries matching 8 LINE_RENDERERS (quality merged into guard)

function rightModel(ctx) {
  const parts = [];
  if (ctx.sessionDuration) parts.push(dim(`⏱ ${ctx.sessionDuration}`));
  const cost = calculateCost(ctx.tokenStats, ctx.stdin?.model?.id ?? ctx.stdin?.model?.display_name);
  if (cost > 0) parts.push(cyan(formatCost(cost)));
  const stats = ctx.tokenStats;
  if (stats?.durationMin > 0 && stats?.totalOutput > 0) {
    const tokPerSec = Math.round(stats.totalOutput / (stats.durationMin * 60));
    if (tokPerSec > 0) parts.push(dim(`${tokPerSec}tok/s`));
  }
  if (stats?.agentSpawns > 0) parts.push(dim(`${stats.agentSpawns}agents`));
  return parts.join('  ') || dim('--');
}

function rightContext(ctx) {
  const parts = [];
  const stats = ctx.tokenStats;
  if (stats?.peakContext > 0) parts.push(dim(`peak:${formatTokens(stats.peakContext)}`));
  if (ctx.compactionCount > 0) {
    const color = ctx.compactionCount > 3 ? yellow : dim;
    parts.push(color(`compact×${ctx.compactionCount}`));
  }
  const pct = ctx.stdin.context_window?.used_percentage ?? 0;
  if (pct > 0) {
    const colorFn = pct >= 85 ? red : pct >= 70 ? yellow : green;
    parts.push(colorFn(miniBar(pct)));
  }
  return parts.join('  ') || dim('--');
}

function rightUsage(ctx) {
  const adv = ctx.advisory;
  if (!adv?.fiveHour && !adv?.sevenDay) return dim('--');
  const parts = [];

  // Time to exhaustion (from rate engine)
  if (adv.fiveHour?.tte > 0) {
    const tteStr = formatTteShort(adv.fiveHour.tte);
    const color = adv.fiveHour.tte < 3600 ? red : adv.fiveHour.tte < 7200 ? yellow : dim;
    parts.push(color(`exhaust:${tteStr}`));
  }

  // Session count
  if (adv.estimatedSessions > 1) {
    parts.push(yellow(`${adv.estimatedSessions} sessions`));
  }

  if (adv.fiveHour?.resetIn) parts.push(dim(`resets ${adv.fiveHour.resetIn}`));
  return parts.join('  ') || dim('--');
}

function formatTteShort(sec) {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  return h >= 24 ? `${Math.floor(h / 24)}d` : `${h}h`;
}

function rightTokens(ctx) {
  const stats = ctx.tokenStats;
  if (!stats) return dim('--');
  const parts = [];
  if (stats.thinkingTurns > 0) parts.push(dim(`think:${stats.thinkingTurns}`));
  if (stats.userTurns > 0) parts.push(dim(`turns:${stats.userTurns}`));
  const cost = calculateCost(stats, ctx.stdin?.model?.id ?? ctx.stdin?.model?.display_name);
  if (cost > 0) parts.push(cyan(`Σ${formatCost(cost)}`));
  const rtk = ctx.rtkStats;
  if (rtk?.totalCommands > 0) parts.push(dim(`rtk:${rtk.totalCommands}cmds`));
  return parts.join('  ') || dim('--');
}

function rightMcps(ctx) {
  const parts = [];
  const total = ctx.mcpCount ?? 0;
  const active = ctx.activeMcps?.length ?? 0;
  const unused = total - active;
  if (unused > 0) parts.push(dim(`${unused} unused`));
  if (ctx.healthSummary?.mcpFailures > 0) {
    parts.push(red(`${ctx.healthSummary.mcpFailures} issues`));
  }
  return parts.join('  ') || (total > 0 ? dim(`${total} ok`) : dim('--'));
}

function rightEnv(ctx) {
  const parts = [];
  const modelId = ctx.stdin.model?.id ?? ctx.stdin.model?.display_name;
  if (modelId) {
    const short = modelId.replace('claude-', '').replace(/-\d+$/, '');
    parts.push(dim(`model:${short}`));
  }
  const size = ctx.stdin.context_window?.context_window_size;
  if (size) parts.push(dim(`ctx:${formatTokens(size)}`));
  return parts.join('  ') || dim('--');
}

function rightGuard(ctx) {
  const guard = ctx.guardStatus;
  if (!guard?.running) return red('service down');
  const parts = [];
  if (guard.activationsToday > 0) {
    parts.push(dim(`${guard.activationsToday}/day`));
    if (guard.lastFlag) parts.push(dim(`last:${guard.lastFlag}`));
  } else {
    parts.push(green('clean'));
  }
  return parts.join('  ');
}

function rightAdvisor(ctx) {
  const adv = ctx.advisory;
  if (!adv) return dim('--');
  const parts = [];
  if (adv.fiveHour?.current !== null) {
    const lvl = adv.fiveHour.level;
    const color = lvl === 'ok' ? green : lvl === 'watch' ? cyan : lvl === 'tight' ? yellow : red;
    parts.push(color(`5h:${miniBar(adv.fiveHour.current)}${adv.fiveHour.current}%`));
  }
  if (adv.sevenDay?.current !== null) {
    const lvl = adv.sevenDay.level;
    const color = lvl === 'ok' ? green : lvl === 'watch' ? cyan : lvl === 'tight' ? yellow : red;
    parts.push(color(`7d:${miniBar(adv.sevenDay.current)}${adv.sevenDay.current}%`));
  }
  return parts.join('  ') || dim('--');
}
