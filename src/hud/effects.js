import { existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PLUGIN_DIR, historyMarkerFor } from '../data/paths.js';
import { writeHistoryEntry } from '../analytics/history.js';
import { calculateBillableCost, calculateCost } from '../analytics/cost.js';
import { getModelName, getContextPercent, getStatusLineCost, getContextUsage } from '../data/stdin.js';

const HISTORY_DEBOUNCE_MS = 30_000;
const ANALYTICS_KICK_FILE = join(PLUGIN_DIR, 'analytics-start.last');

export function maybeWriteHistory(sessionId, usageData, tokenStats, advisory, effort, stdin, rtkStats, runtimeMode, vertexTelemetry = null, billingUsage = null) {
  try {
    const marker = sessionId
      ? historyMarkerFor(sessionId)
      : join(PLUGIN_DIR, '.last-history-write');

    let lastWrite = 0;
    if (existsSync(marker)) {
      lastWrite = statSync(marker).mtimeMs;
    }
    if (Date.now() - lastWrite < HISTORY_DEBOUNCE_MS) return;

    mkdirSync(PLUGIN_DIR, { recursive: true });
    writeFileSync(marker, '');

    const modelName = getModelName(stdin);
    const isCostMetered = runtimeMode?.billingSignal === 'cost-metered';
    const statusLineCost = getStatusLineCost(stdin);
    const contextUsage = getContextUsage(stdin);
    const nativeCost = statusLineCost.costUsd;
    const computedCost = isCostMetered && tokenStats ? calculateBillableCost(tokenStats, modelName) : null;
    const sessionCostUsd = billingUsage?.costUsd ?? nativeCost ?? computedCost;
    const costKind = nativeCost != null ? 'api_statusline_actual' : (isCostMetered ? 'api_billable_estimate' : null);
    writeHistoryEntry({
      sessionId,
      fiveHourPct: usageData?.fiveHour ?? null,
      sevenDayPct: usageData?.sevenDay ?? null,
      sessionBurnRate: tokenStats?.burnRate ?? 0,
      contextPct: getContextPercent(stdin),
      signal: advisory?.signal ?? 'nominal',
      model: modelName,
      effort,
      rtkSaved: rtkStats?.totalSaved ?? null,
      rtkSavingsPct: rtkStats?.avgSavingsPct ?? null,
      sessionCostUsd,
      generationCostUsd: tokenStats ? calculateCost(tokenStats, modelName) : null,
      costKind,
      mode: runtimeMode?.mode ?? null,
      billingSignal: runtimeMode?.billingSignal ?? null,
      authProvider: runtimeMode?.authProvider ?? null,
      backend: runtimeMode?.backend ?? null,
      telemetryAuthority: runtimeMode?.telemetryAuthority ?? null,
      projectPath: stdin?.workspace?.project_dir ?? stdin?.cwd ?? null,
      contextTokens: contextUsage.totalTokens,
      contextInputTokens: contextUsage.inputTokens,
      contextOutputTokens: contextUsage.outputTokens,
      contextThinkingTokens: contextUsage.thinkingTokens,
      exceeds200k: contextUsage.exceeds200k,
      inputTokens: tokenStats?.totalInput ?? null,
      outputTokens: tokenStats?.totalOutput ?? null,
      cacheCreateTokens: tokenStats?.totalCacheCreate ?? null,
      cacheCreate5mTokens: tokenStats?.totalCacheCreate5m ?? null,
      cacheCreate1hTokens: tokenStats?.totalCacheCreate1h ?? null,
      cacheReadTokens: tokenStats?.totalCacheRead ?? null,
      apiCalls: tokenStats?.apiCalls ?? null,
      vertexTelemetry,
    });
  } catch { /* non-critical */ }
}

export function kickAnalyticsDaemon(env = process.env, now = Date.now()) {
  if (env.CLAUDE_OPS_DISABLE_ANALYTICS === '1' || env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') return false;
  const throttleMs = envMs('CLAUDE_OPS_ANALYTICS_START_THROTTLE_MS', 60_000, 5_000, env);
  if (!analyticsKickDue(ANALYTICS_KICK_FILE, now, throttleMs)) return false;

  try {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    writeFileSync(ANALYTICS_KICK_FILE, `${new Date(now).toISOString()}\n`);
    const child = spawn('systemctl', ['--user', '--no-block', 'start', 'claude-ops-analytics.service'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function analyticsKickDue(path, now, throttleMs) {
  try {
    if (!existsSync(path)) return true;
    return now - statSync(path).mtimeMs >= throttleMs;
  } catch {
    return true;
  }
}

function envMs(name, fallback, min, env = process.env) {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, value);
}
