import { readFileSync } from 'node:fs';
import { getClaudeConfigDir, HEALTH_REPORT_FILE } from '../data/paths.js';
import { readJson } from '../data/jsonl.js';
import { costWeightedBurnRate, ewmaBurnRate } from '../analytics/cost.js';
import { getContextUsage, getStatusLineEffort } from '../data/stdin.js';

const DAEMON_STALE_THRESHOLD_SEC = 30; // 2 × POLL_INTERVAL_MS (15 s)

export function computeDaemonStaleSec(writtenAt) {
  if (!writtenAt) return null;
  const parsed = Date.parse(writtenAt);
  if (!Number.isFinite(parsed)) return null;
  const ageSec = Math.round((Date.now() - parsed) / 1000);
  if (ageSec < DAEMON_STALE_THRESHOLD_SEC) return null;
  return ageSec;
}

/**
 * Augment cached token stats with fresh stdin data.
 * stdin has current_usage from this render cycle — always fresher than daemon cache.
 * sessionStart (from transcript) is used to compute duration when daemon cache has dur=0.
 */
export function augmentTokenStats(cached, stdin, sessionStart, modelName, writtenAt = null) {
  const contextUsage = getContextUsage(stdin);
  const usage = stdin?.context_window?.current_usage;
  if (!usage && contextUsage.totalTokens === 0) return cached;

  const base = cached ?? {
    totalInput: 0, totalOutput: 0, totalCacheCreate: 0, totalCacheRead: 0,
    apiCalls: 0, burnRate: 0, tools: {}, mcps: {}, agentSpawns: 0, durationMin: 0,
    recentTurnsOutput: [],
  };

  const input = contextUsage.inputTokens;
  const output = contextUsage.outputTokens;
  const cacheCreate = contextUsage.cacheCreateTokens;
  const cacheRead = contextUsage.cacheReadTokens;

  const freshInput = Math.max(base.totalInput, input);
  const freshOutput = Math.max(base.totalOutput, output);
  const freshCacheCreate = Math.max(base.totalCacheCreate, cacheCreate);
  const freshCacheRead = Math.max(base.totalCacheRead, cacheRead);

  const transcriptDurMin = sessionStart
    ? Math.max(1, (Date.now() - sessionStart.getTime()) / 60_000)
    : 0;
  const durationMin = base.durationMin > 0 ? base.durationMin : transcriptDurMin;

  const freshBurn = costWeightedBurnRate({
    totalInput: freshInput,
    totalOutput: freshOutput,
    totalCacheCreate: freshCacheCreate,
    totalCacheRead: freshCacheRead,
    durationMin,
  }, modelName);
  const burnRate = freshBurn || base.burnRate;
  const staleSec = computeDaemonStaleSec(writtenAt);
  const burnRateStale = !freshBurn && base.burnRate > 0 && staleSec !== null;

  const burnRateSmoothed = ewmaBurnRate(base.recentTurnsOutput, durationMin);

  return {
    ...base,
    totalInput: freshInput,
    totalOutput: freshOutput,
    totalCacheCreate: freshCacheCreate,
    totalCacheRead: freshCacheRead,
    durationMin,
    burnRate,
    burnRateStale,
    burnRateSmoothed,
    burnRateModel: modelName ?? null,
    contextUsage,
  };
}

export function readHealthSummary() {
  const report = readJson(HEALTH_REPORT_FILE);
  if (!report) return null;
  return { mcpFailures: report.issueCount ?? 0 };
}

export function detectEffort(env = process.env, stdin = null) {
  const statusLineEffort = getStatusLineEffort(stdin);
  if (statusLineEffort) return statusLineEffort;

  const value = env.CLAUDE_CODE_EFFORT_LEVEL
    ?? env.CLAUDE_CODE_EFFORT
    ?? env.ANTHROPIC_EFFORT
    ?? env.EFFORT;
  if (value) return value.toLowerCase();

  try {
    const settingsPath = `${getClaudeConfigDir()}/settings.json`;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (settings.effortLevel) return settings.effortLevel.toLowerCase();
  } catch { /* ignore */ }

  return 'high';
}

export function hasApiKeyHelper() {
  try {
    const settingsPath = `${getClaudeConfigDir()}/settings.json`;
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return Boolean(settings.apiKeyHelper);
  } catch {
    return false;
  }
}
