/**
 * Line 4: Tokens — in:42K  out:9.5K  cache:████░░ 69%  burn:211t/m  18calls
 * Now with cache bar visualization and wider spacing.
 */
import { cyan, dim, getCacheColor, getBurnColor, coloredBar, RESET } from '../colors.js';

const SEP = ` ${dim('│')} `;
import { formatTokens, padLabel } from '../format.js';
import { calculateCost, formatCost } from '../../analytics/cost.js';
import { sparkline } from '../sparkline.js';

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

  const cacheLabel = cacheBasis === 'rolling' ? 'cache' : dim('cache*');
  // Honest placeholder when the session has literally no cache activity
  // yet: `cache:--` (dim) instead of `cache:0%`. The latter is a valid
  // reading for a degraded session; conflating the two hides regressions.
  const hasCacheActivity = (cacheCreate + cacheRead) > 0;
  const cacheBlock = hasCacheActivity
    ? `${cacheLabel}:${cacheBar} ${cacheColor}${cachePercent}%${RESET}` +
      (ttlSplit ? ` ${dim(ttlSplit)}` : '')
    : dim('cache:--');

  const primary = [
    cyan(`in:${inTok}`),
    cyan(`out:${outTok}`),
    ...(sparkStr ? [sparkStr] : []),
    cacheBlock,
  ];

  const burnLabel = stats.burnRateStale
    ? `${burnColor}burn:${Math.round(burnRate)}t/m${RESET}${dim('·stale')}`
    : `${burnColor}burn:${Math.round(burnRate)}t/m${RESET}`;
  const secondary = [
    burnLabel,
    dim(`${apiCalls}calls`),
  ];

  // Session cost
  if (cost > 0) secondary.push(cyan(formatCost(cost)));

  // R:E quality badge lives on the Guard line (HUD-SPEC §7). Tokens line
  // keeps burn/cost/cache, which is already dense.

  return `${dim(label)} ${primary.join('  ')}${SEP}${secondary.join('  ')}`;
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
