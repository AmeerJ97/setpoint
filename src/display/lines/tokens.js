/**
 * Line 4: Tokens — in:42K  out:9.5K  cache:████░░ 69%  burn:211t/m  18calls
 * Now with cache bar visualization and wider spacing.
 */
import { cyan, dim, green, yellow, red, getCacheColor, getBurnColor, coloredBar, RESET } from '../colors.js';

const SEP = ` ${dim('│')} `;
import { formatTokens, formatRate, formatCount, padLabel, padVisualEnd } from '../format.js';
import { calculateCost, formatCost } from '../../analytics/cost.js';
import { sparkline } from '../sparkline.js';
import { inspectPromptCacheConfig } from '../../data/prompt-cache.js';

// Grid anchor shared with Context / Guard / Advisor so the first
// `│` separator stacks vertically across lines.
const PRIMARY_COL_WIDTH = 32;

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderTokensLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Tok' : 'Tokens', narrow);
  const stats = ctx.tokenStats;

  if (!stats) {
    return `${dim(label)} ${dim('in:--  out:--  cache:--%  burn:--')}`;
  }

  const inTok = formatTokens(stats.totalInput ?? 0);
  const outTok = formatTokens(stats.totalOutput ?? 0);

  // Cache efficiency — rolling 10-turn window (Phase 1.4) so the value
  // reflects current behavior. Session-cumulative buried regressions
  // under hours of good cache reads (#46829-class). Falls back to the
  // cumulative figure when the rolling window has < 2 turns of data.
  const cacheCreate = stats.totalCacheCreate ?? 0;
  const cacheRead = stats.totalCacheRead ?? 0;
  const { percent: cachePercent, basis: cacheBasis } = computeCachePercent(stats);
  const cacheColor = getCacheColor(cachePercent);
  const cacheBar = coloredBar(cachePercent, narrow ? 3 : 5, getCacheColor);

  // TTL split overlay: shows where cache writes are landing. When the
  // 5m share creeps up despite ENABLE_PROMPT_CACHING_1H being set, the
  // server silently regressed (per #46829). Emit only when there is
  // any cache_create activity to summarise.
  const create5m = stats.totalCacheCreate5m ?? 0;
  const create1h = stats.totalCacheCreate1h ?? 0;
  const ttlSplit = formatTtlSplit(create5m, create1h);

  // Burn rate
  const burnRate = stats.burnRate ?? 0;
  const burnColor = getBurnColor(burnRate);

  const apiCalls = stats.apiCalls ?? 0;

  // Session cost estimate
  const modelName = ctx.stdin?.model?.id ?? ctx.stdin?.model?.display_name;
  const cost = calculateCost(stats, modelName);

  // Per-turn sparkline (last ~8 assistant turns, output tokens each).
  // Single-glance "is this session burning hot right now?" signal.
  const turns = Array.isArray(stats.recentTurnsOutput) ? stats.recentTurnsOutput : [];
  const sparkStr = turns.length >= 2
    ? dim('⎡') + sparkline(turns, narrow ? 5 : 8) + dim('⎤')
    : '';

  const cacheLabel = cacheBasis === 'rolling' ? 'cache' : dim('cache-hist');
  // Honest placeholder when the session has literally no cache activity
  // yet: `cache:--` (dim) instead of `cache:0%`. The latter is a valid
  // reading for a degraded session; conflating the two hides regressions.
  const hasCacheActivity = (cacheCreate + cacheRead) > 0;
  const cacheBlock = hasCacheActivity
    ? `${cacheLabel}:${cacheBar} ${cacheColor}${cachePercent}%${RESET}` +
      (ttlSplit ? ` ${dim(ttlSplit)}` : '')
    : dim('cache:--');
  const nativeCache = formatNativeCacheNote(ctx);
  const cacheConfigNote = formatPromptCacheConfigNote(ctx);
  const rtkNote = formatRtkNote(ctx);

  const primary = [
    cyan(`in:${inTok}`),
    cyan(`out:${outTok}`),
    ...(sparkStr ? [sparkStr] : []),
    cacheBlock,
  ].join(' ');

  const burnStr = formatRate(burnRate);
  const burnLabel = stats.burnRateStale
    ? `${burnColor}burn:${burnStr} t/m${RESET}${dim(' · stale')}`
    : `${burnColor}burn:${burnStr} t/m${RESET}`;
  const secondary = [
    nativeCache,
    cacheConfigNote,
    rtkNote,
    burnLabel,
    ...(apiCalls > 0 ? [dim(`${formatCount(apiCalls)} calls`)] : []),
  ].filter(Boolean);

  // Session cost
  if (cost > 0 && ctx.billingSignal !== 'cost-metered') secondary.push(cyan(formatCost(cost)));

  // R:E quality badge lives on the Guard line (HUD-SPEC §7). Tokens line
  // keeps burn/cost/cache, which is already dense.

  return `${dim(label)} ${padVisualEnd(primary, PRIMARY_COL_WIDTH)}${SEP}${secondary.join('  ')}`;
}

function formatPromptCacheConfigNote(ctx) {
  const info = ctx.promptCacheConfig ?? inspectPromptCacheConfig(null, process.env, { activeModelId: ctx.stdin?.model?.id ?? ctx.stdin?.model?.display_name });
  if (info.mode === 'off') return red('cfg:off');
  if (info.mode === '1h') return green('cfg:1h');
  return yellow('cfg:5m');
}

function formatNativeCacheNote(ctx) {
  const stats = ctx.tokenStats;
  const current = ctx.stdin?.context_window?.current_usage ?? {};
  const read = stats ? (stats.totalCacheRead ?? 0) : (current.cache_read_input_tokens ?? 0);
  const write = stats ? (stats.totalCacheCreate ?? 0) : (current.cache_creation_input_tokens ?? 0);
  const create5m = stats?.totalCacheCreate5m ?? 0;
  const create1h = stats?.totalCacheCreate1h ?? 0;

  if (read > 0) {
    const ttl = formatCacheTtlShort(create5m, create1h);
    return green(`native:on${ttl ? ` ${ttl}` : ''}`);
  }
  if (write > 0) {
    const ttl = formatCacheTtlShort(create5m, create1h);
    return yellow(`native:write${ttl ? ` ${ttl}` : ''}`);
  }
  if (stats || ctx.stdin?.context_window?.current_usage) return dim('native:idle');
  return dim('native:unknown');
}

function formatCacheTtlShort(create5m, create1h) {
  const total = create5m + create1h;
  if (total <= 0) return null;
  const pct5m = Math.round((create5m / total) * 100);
  if (pct5m >= 98) return '5m';
  if (pct5m <= 2) return '1h';
  return `${pct5m}%5m`;
}

function formatRtkNote(ctx) {
  const rtk = ctx.rtkStats;
  const status = ctx.rtkStatus?.state ?? inferRtkState(rtk);
  if (status === 'disabled') return yellow('rtk:disabled');
  if (status === 'off') return dim('rtk:off');
  if (!rtk) return dim(`rtk:${status}`);

  const pct = Math.round(rtk.avgSavingsPct ?? 0);
  const saved = rtk.totalSaved ?? 0;
  const savedStr = formatTokens(saved);
  const detail = saved > 0 ? ` ${savedStr}↓${pct}%` : '';

  if (status === 'stale') return dim(`rtk:stale${saved > 0 ? ` ${savedStr}` : ''}`);
  if (status === 'saving') {
    const rtkColor = pct >= 80 ? green : pct >= 50 ? yellow : red;
    return rtkColor(`rtk:saving${detail}`);
  }
  return cyan(`rtk:on${detail}`);
}

function inferRtkState(rtk) {
  if (!rtk) return 'off';
  const ageMs = rtk.mtimeMs ? Date.now() - rtk.mtimeMs : 0;
  if (Number.isFinite(ageMs) && ageMs > 10 * 60_000) return 'stale';
  if ((rtk.totalSaved ?? 0) > 0) return 'saving';
  return 'on';
}

const ROLLING_CACHE_TURNS = 10;

/**
 * Rolling-window cache hit % over the last N turns. Falls back to the
 * cumulative figure when the per-turn series is empty (legacy daemon
 * data) or has fewer than 2 turns to average.
 *
 * @param {object} stats
 * @returns {{ percent: number, basis: 'rolling'|'cumulative' }}
 */
function computeCachePercent(stats) {
  const reads = Array.isArray(stats.recentTurnsCacheRead) ? stats.recentTurnsCacheRead : [];
  const writes = Array.isArray(stats.recentTurnsCacheCreate) ? stats.recentTurnsCacheCreate : [];
  const n = Math.min(ROLLING_CACHE_TURNS, reads.length, writes.length);
  if (n >= 2) {
    let r = 0, w = 0;
    for (let i = reads.length - n; i < reads.length; i++) r += reads[i] ?? 0;
    for (let i = writes.length - n; i < writes.length; i++) w += writes[i] ?? 0;
    const total = r + w;
    if (total > 0) return { percent: Math.round((r / total) * 100), basis: 'rolling' };
  }
  const cr = stats.totalCacheRead ?? 0;
  const cc = stats.totalCacheCreate ?? 0;
  const total = cr + cc;
  return {
    percent: total > 0 ? Math.round((cr / total) * 100) : 0,
    basis: 'cumulative',
  };
}

/**
 * Format the 5m / 1h cache-write split. Returns null when there's no
 * write activity to summarise. Suppresses the split when it's
 * trivially one-sided (≥98% in one tier) — the salient case is when
 * the user has 1h enabled but writes are landing as 5m.
 *
 * @param {number} create5m
 * @param {number} create1h
 * @returns {string|null}
 */
function formatTtlSplit(create5m, create1h) {
  const total = create5m + create1h;
  if (total <= 0) return null;
  const pct5m = Math.round((create5m / total) * 100);
  const pct1h = 100 - pct5m;
  if (pct5m >= 98) return '(5m only)';
  if (pct1h >= 98) return '(1h only)';
  return `(5m:${pct5m}%/1h:${pct1h}%)`;
}
