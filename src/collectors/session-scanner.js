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
    apiCalls: 0, burnRate: 0, tools: {}, mcps: {}, agentSpawns: 0,
    durationMin: 0, peakContext: 0,
    recentTurnsOutput: [],
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
  totals.apiCalls         = s.apiCalls         ?? 0;
  totals.agentSpawns      = s.agentSpawns      ?? 0;
  totals.durationMin      = s.durationMin      ?? s.dur ?? 0;
  totals.peakContext      = s.peakContext      ?? 0;
  totals.thinkingTurns    = s.thinkingTurns    ?? 0;
  totals.userTurns        = s.userTurns        ?? 0;
  totals.tools            = { ...(s.tools ?? {}) };
  totals.mcps             = { ...(s.mcps  ?? {}) };
  totals.recentTurnsOutput = Array.isArray(s.recentTurnsOutput) ? s.recentTurnsOutput.slice() : [];

  if (totals.durationMin > 0) {
    totals.burnRate = Math.round(totals.totalOutput / totals.durationMin);
  }
  return totals;
}

/**
 * Read this session's cached token stats. Scoped to sessionId when
 * provided; falls back to legacy aggregated cache otherwise.
 * @param {string|null} [sessionId]
 * @returns {TokenStats|null}
 */
export function readCachedTokenStats(sessionId = null) {
  if (sessionId) {
    const record = readJson(tokenStatsFileFor(sessionId));
    if (record) return normalizeRecord(record);
  }

  const legacy = readJson(TOKEN_STATS_LATEST);
  if (!legacy?.sessions?.length) return null;

  // Legacy path: file contained all sessions. If we can match by id
  // inside the aggregate, return only that session's row. Otherwise
  // aggregate (v1 behaviour) for one render cycle so the HUD shows
  // something non-empty until the daemon writes a per-session file.
  if (sessionId) {
    const row = legacy.sessions.find(s => s.sid === sessionId);
    if (row) return normalizeRecord(row);
  }

  const totals = emptyTotals();
  for (const s of legacy.sessions) {
    totals.totalInput       += s.totalInput       ?? 0;
    totals.totalOutput      += s.totalOutput      ?? 0;
    totals.totalCacheCreate += s.totalCacheCreate ?? 0;
    totals.totalCacheRead   += s.totalCacheRead   ?? 0;
    totals.apiCalls         += s.apiCalls         ?? 0;
    totals.agentSpawns      += s.agentSpawns      ?? 0;
    totals.durationMin      += s.dur              ?? 0;
    for (const [tool, count] of Object.entries(s.tools ?? {})) {
      totals.tools[tool] = (totals.tools[tool] ?? 0) + count;
    }
    for (const [mcp, count] of Object.entries(s.mcps ?? {})) {
      totals.mcps[mcp] = (totals.mcps[mcp] ?? 0) + count;
    }
  }
  if (totals.durationMin > 0) {
    totals.burnRate = Math.round(totals.totalOutput / totals.durationMin);
  }
  return totals;
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
