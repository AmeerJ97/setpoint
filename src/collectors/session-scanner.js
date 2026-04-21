/**
 * Session scanner — reads one session's cached token stats.
 *
 * Per-session partitioning (v2.0): each active session has its own
 * cache file at `token-stats/{sessionId}.json`. Concurrent sessions
 * never see each other's data. When sessionId is null or a per-session
 * file is absent, we fall back to the legacy aggregated cache
 * (`token-stats-latest.json`) that v1 wrote — this keeps upgraded
 * installs working while the daemon catches up on its first poll.
 */
import { readJson } from '../data/jsonl.js';
import { TOKEN_STATS_LATEST, tokenStatsFileFor } from '../data/paths.js';
import { costWeightedBurnRate } from '../analytics/cost.js';

/**
 * Pick the most-frequently-used model from the daemon's per-session
 * model-counts map. Used to attribute the cost-weighted burn rate to
 * the right pricing row.
 */
function primaryModel(models) {
  if (!models || typeof models !== 'object') return null;
  let best = null, bestN = -1;
  for (const [name, n] of Object.entries(models)) {
    if (typeof n === 'number' && n > bestN) { bestN = n; best = name; }
  }
  return best;
}

/**
 * @typedef {object} TokenStats
 * @property {number} totalInput
 * @property {number} totalOutput
 * @property {number} totalCacheCreate
 * @property {number} totalCacheRead
 * @property {number} apiCalls
 * @property {number} burnRate - tokens/minute
 * @property {object} tools
 * @property {object} mcps
 * @property {number} agentSpawns
 * @property {number} durationMin
 * @property {number} [peakContext]
 */

function emptyTotals() {
  return {
    totalInput: 0, totalOutput: 0, totalCacheCreate: 0, totalCacheRead: 0,
    totalCacheCreate5m: 0, totalCacheCreate1h: 0,
    apiCalls: 0, burnRate: 0, tools: {}, mcps: {}, agentSpawns: 0,
    durationMin: 0, peakContext: 0,
    recentTurnsOutput: [],
    recentTurnsCacheCreate: [],
    recentTurnsCacheRead: [],
  };
}

/**
 * Copy a daemon-written per-session record into the TokenStats shape
 * the renderer expects. The daemon uses `dur` for duration; normalize
 * to `durationMin` here.
 */
function normalizeRecord(s) {
  const totals = emptyTotals();
  totals.totalInput       = s.totalInput       ?? 0;
  totals.totalOutput      = s.totalOutput      ?? 0;
  totals.totalCacheCreate = s.totalCacheCreate ?? 0;
  totals.totalCacheRead   = s.totalCacheRead   ?? 0;
  totals.totalCacheCreate5m = s.totalCacheCreate5m ?? 0;
  totals.totalCacheCreate1h = s.totalCacheCreate1h ?? 0;
  totals.apiCalls         = s.apiCalls         ?? 0;
  totals.agentSpawns      = s.agentSpawns      ?? 0;
  totals.durationMin      = s.durationMin      ?? s.dur ?? 0;
  totals.peakContext      = s.peakContext      ?? 0;
  totals.thinkingTurns    = s.thinkingTurns    ?? 0;
  totals.userTurns        = s.userTurns        ?? 0;
  totals.tools            = { ...(s.tools ?? {}) };
  totals.mcps             = { ...(s.mcps  ?? {}) };
  totals.recentTurnsOutput = Array.isArray(s.recentTurnsOutput) ? s.recentTurnsOutput.slice() : [];
  totals.recentTurnsCacheCreate = Array.isArray(s.recentTurnsCacheCreate) ? s.recentTurnsCacheCreate.slice() : [];
  totals.recentTurnsCacheRead = Array.isArray(s.recentTurnsCacheRead) ? s.recentTurnsCacheRead.slice() : [];
  totals.primaryModel = primaryModel(s.models);

  if (totals.durationMin > 0) {
    totals.burnRate = costWeightedBurnRate(totals, totals.primaryModel);
  }
  return totals;
}

/**
 * Read this session's cached token stats. Strictly session-scoped: when
 * a sessionId is known, only that session's record counts. A fresh
 * session must show zero stats, not the legacy cross-session aggregate
 * — otherwise the HUD shows impossible numbers on turn 1 (e.g. 243m
 * duration, $21 cost, 800K output on a session that hasn't sent a
 * message yet).
 *
 * @param {string|null} [sessionId]
 * @returns {TokenStats|null}
 */
export function readCachedTokenStats(sessionId = null) {
  if (sessionId) {
    const record = readJson(tokenStatsFileFor(sessionId));
    if (record) return normalizeRecord(record);
    // Per-session file not yet written — this IS a fresh session.
    // Legacy aggregate also has a row keyed by sid? Use only that row.
    const legacy = readJson(TOKEN_STATS_LATEST);
    const row = legacy?.sessions?.find(s => s.sid === sessionId);
    if (row) return normalizeRecord(row);
    return null;
  }

  // No sessionId passed — no cached stats to trust. Don't aggregate
  // across sessions; that produces the "fresh session shows cumulative
  // totals" bug reported on 2026-04-20.
  return null;
}

/**
 * Read cached token stats plus the daemon's `writtenAt` timestamp so
 * callers can show a staleness indicator if the daemon has wedged.
 * Returns `{data, writtenAt}` where writtenAt is ISO-8601 or null.
 * @param {string|null} [sessionId]
 * @returns {{data: TokenStats|null, writtenAt: string|null}}
 */
export function readCachedTokenStatsMeta(sessionId = null) {
  if (!sessionId) return { data: null, writtenAt: null };
  const record = readJson(tokenStatsFileFor(sessionId));
  if (record) {
    return { data: normalizeRecord(record), writtenAt: record.writtenAt ?? null };
  }
  const legacy = readJson(TOKEN_STATS_LATEST);
  const row = legacy?.sessions?.find(s => s.sid === sessionId);
  if (row) {
    return { data: normalizeRecord(row), writtenAt: legacy.writtenAt ?? null };
  }
  return { data: null, writtenAt: null };
}

/**
 * MCP server names actually used by this session (or the legacy
 * aggregate if no session id), sorted by invocation count descending.
 * @param {string|null} [sessionId]
 * @returns {string[]}
 */
export function getActiveMcpNames(sessionId = null) {
  const stats = readCachedTokenStats(sessionId);
  if (!stats?.mcps) return [];
  return Object.keys(stats.mcps).sort(
    (a, b) => (stats.mcps[b] ?? 0) - (stats.mcps[a] ?? 0),
  );
}
