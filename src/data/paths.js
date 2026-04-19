import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

/**
 * Resolve the Claude config directory. Respects CLAUDE_CONFIG_DIR env var.
 * @param {string} [home]
 * @returns {string}
 */
export function getClaudeConfigDir(home = HOME) {
  const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envDir) {
    if (envDir === '~') return home;
    if (envDir.startsWith('~/') || envDir.startsWith('~\\')) {
      return join(home, envDir.slice(2));
    }
    return envDir;
  }
  return join(home, '.claude');
}

export const CLAUDE_DIR = getClaudeConfigDir();
export const CLAUDE_JSON_PATH = `${CLAUDE_DIR}.json`;
export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions');
export const PLUGIN_DIR = join(CLAUDE_DIR, 'plugins', 'claude-hud');
export const HISTORY_FILE = join(PLUGIN_DIR, 'usage-history.jsonl');
export const TOKEN_STATS_FILE = join(PLUGIN_DIR, 'token-stats.jsonl');
export const TOKEN_STATS_LATEST = join(PLUGIN_DIR, 'token-stats-latest.json');
export const TOKEN_STATS_DIR = join(PLUGIN_DIR, 'token-stats');

/**
 * Path for one session's live token stats. Per-session partitioning
 * prevents concurrent sessions from reading each other's aggregated data.
 * @param {string} sessionId
 * @returns {string}
 */
export function tokenStatsFileFor(sessionId) {
  return join(TOKEN_STATS_DIR, `${sessionId}.json`);
}

/**
 * Path for one session's history-write debounce marker. The old global
 * marker caused last-writer-wins across concurrent sessions.
 * @param {string} sessionId
 * @returns {string}
 */
export function historyMarkerFor(sessionId) {
  return join(PLUGIN_DIR, `.last-history-write.${sessionId}`);
}
export const HEALTH_REPORT_FILE = join(PLUGIN_DIR, 'health-report.json');
export const DAILY_REPORT_FILE = join(PLUGIN_DIR, 'daily-report.md');
export const ANOMALY_LOG_FILE = join(PLUGIN_DIR, 'anomaly-log.jsonl');
export const RTK_STATS_FILE = join(PLUGIN_DIR, 'rtk-stats.json');
export const RTK_STATS_DIR = join(PLUGIN_DIR, 'rtk-stats');

/**
 * Path for one session's RTK stats snapshot.
 * @param {string} sessionId
 * @returns {string}
 */
export function rtkStatsFileFor(sessionId) {
  return join(RTK_STATS_DIR, `${sessionId}.json`);
}
export const GUARD_LOG_FILE = '/tmp/claude-quality-guard.log';
export const TRANSCRIPT_CACHE_DIR = join(PLUGIN_DIR, 'transcript-cache');

// JSONL rotation limits
export const ROTATION = {
  ANOMALY_LOG:    { maxBytes: 2 * 1024 * 1024, keepLines: 5000 },
  TOKEN_STATS:    { maxBytes: 5 * 1024 * 1024, keepLines: 10000 },
  USAGE_HISTORY:  { maxBytes: 2 * 1024 * 1024, keepLines: 5000 },
};
