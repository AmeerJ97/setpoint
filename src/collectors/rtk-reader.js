/**
 * RTK stats reader — reads cached RTK metrics from daemon-written JSON.
 * Prefers the per-session file when a sessionId is provided, falling
 * back to the legacy global file (for installs where the daemon
 * hasn't yet written a per-session snapshot).
 */
import { readJson } from '../data/jsonl.js';
import { RTK_STATS_FILE, rtkStatsFileFor } from '../data/paths.js';

/**
 * @typedef {object} RtkStats
 * @property {number} totalCommands
 * @property {number} totalSaved
 * @property {number} avgSavingsPct
 * @property {number} totalTimeMs
 * @property {number} projectSaved
 * @property {number} projectSavingsPct
 * @property {number} projectCommands
 * @property {string} fetchedAt
 */

/**
 * Read cached RTK stats. Scoped by sessionId when provided.
 * @param {string|null} [sessionId]
 * @returns {RtkStats|null}
 */
export function readRtkStats(sessionId = null) {
  let data = null;
  if (sessionId) data = readJson(rtkStatsFileFor(sessionId));
  if (!data) data = readJson(RTK_STATS_FILE);
  if (!data?.global) return null;

  const g = data.global;
  const p = data.project;

  return {
    totalCommands: g.total_commands ?? 0,
    totalSaved: g.total_saved ?? 0,
    avgSavingsPct: g.avg_savings_pct ?? 0,
    totalTimeMs: g.total_time_ms ?? 0,
    projectSaved: p?.total_saved ?? 0,
    projectSavingsPct: p?.avg_savings_pct ?? 0,
    projectCommands: p?.total_commands ?? 0,
    fetchedAt: data.fetchedAt ?? null,
  };
}
