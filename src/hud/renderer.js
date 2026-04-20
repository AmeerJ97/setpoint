#!/usr/bin/env node
/**
 * Claude HUD — Main entry point (one-shot statusLine command).
 * Claude Code invokes this per render cycle: pipes JSON to stdin, reads stdout.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readStdin, getUsageFromStdin, getTotalTokens, getContextPercent, getSessionId } from '../data/stdin.js';
import { isCompressionEnabled } from '../data/config.js';
import { getClaudeConfigDir, PLUGIN_DIR, historyMarkerFor } from '../data/paths.js';
import { parseTranscript } from '../collectors/transcript.js';
import { countConfigs } from '../collectors/config-reader.js';
import { getGitStatus } from '../collectors/git.js';
import { readGuardStatus } from '../collectors/guard-reader.js';
import { readCachedTokenStats, getActiveMcpNames } from '../collectors/session-scanner.js';
import { readRtkStats } from '../collectors/rtk-reader.js';
import { findActiveSessions } from '../data/session.js';
import { readJson } from '../data/jsonl.js';
import { HEALTH_REPORT_FILE } from '../data/paths.js';
import { calculateRates } from '../analytics/rates.js';
import { costWeightedBurnRate, ewmaBurnRate } from '../analytics/cost.js';
import { computeAdvisory } from '../analytics/advisor.js';
import { runAnomalyChecks } from '../anomaly/detector.js';
import { notifyCriticalAnomalies } from '../anomaly/notify.js';
import { writeHistoryEntry } from '../analytics/history.js';
import { render } from '../display/renderer.js';
import { formatDuration } from '../display/format.js';
import { getModelName } from '../data/stdin.js';

async function main() {
  try {
    const stdin = await readStdin();

    if (!stdin) {
      console.log('[claude-hud] Initializing...');
      return;
    }

    // Collect data in parallel
    const [
      transcript,
      configCounts,
      gitStatus,
      guardStatus,
    ] = await Promise.all([
      parseTranscript(stdin.transcript_path ?? ''),
      countConfigs(stdin.cwd),
      getGitStatus(stdin.cwd),
      readGuardStatus(),
    ]);

    // Session id is the primary key for every per-session cache read below.
    const sessionId = getSessionId(stdin);

    // Sync reads (fast, from cache files) — scoped to THIS session.
    const usageData = getUsageFromStdin(stdin);
    const tokenStats = augmentTokenStats(readCachedTokenStats(sessionId), stdin, transcript.sessionStart, getModelName(stdin));
    const activeMcps = getActiveMcpNames(sessionId);
    const isCompressed = isCompressionEnabled();
    const rtkStats = readRtkStats(sessionId);

    // Count of concurrent sessions so the user sees when multiple
    // Claude Code instances are sharing their account's rate limits.
    let activeSessionCount = 1;
    try { activeSessionCount = Math.max(1, findActiveSessions().length); }
    catch { /* readdir failed, default to 1 */ }

    // Aggregate tool counts from transcript first — the advisor engine
    // needs them for the R:E ladder rung, anomaly detector uses them too.
    const toolCounts = {};
    for (const t of transcript.tools) {
      toolCounts[t.name] = (toolCounts[t.name] ?? 0) + 1;
    }

    const contextPercentForAdvisor = getContextPercent(stdin);
    const modelNameForAdvisor = getModelName(stdin);

    // Analytics
    const rates = calculateRates(usageData, tokenStats?.burnRate ?? 0);
    const advisory = computeAdvisory(rates, usageData, {
      toolCounts,
      tokenStats,
      contextPercent: contextPercentForAdvisor,
      modelName: modelNameForAdvisor,
    });

    // Anomaly detection (background drain, token spikes, read:edit ratio, etc.)
    let anomalies = [];
    try {
      const currentUsage = stdin?.context_window?.current_usage ?? {};

      anomalies = runAnomalyChecks({
        // Token data
        outputTokens: currentUsage.output_tokens ?? 0,
        inputTokens: currentUsage.input_tokens ?? 0,
        cacheCreateTokens: currentUsage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: currentUsage.cache_read_input_tokens ?? 0,
        // Session data
        agentSpawns: tokenStats?.agentSpawns ?? 0,
        durationMin: tokenStats?.durationMin ?? 0,
        compactionCount: 0,
        // Context pressure
        contextPercent: contextPercentForAdvisor,
        // Guard data
        guardActivationsPerHour: guardStatus?.activationsPerHour ?? 0,
        // Tool data
        toolCounts,
        // Model
        modelName: modelNameForAdvisor,
      });

      // Send desktop notification for critical anomalies
      notifyCriticalAnomalies(anomalies).catch(() => {});
    } catch { /* don't crash HUD */ }

    // Session duration — prefer transcript, fall back to token stats
    const sessionDuration = formatDuration(transcript.sessionStart)
      || (tokenStats?.durationMin ? `${tokenStats.durationMin}m` : '');

    const effort = detectEffort();
    const healthSummary = readHealthSummary();

    // Build render context
    const ctx = {
      stdin,
      usageData,
      gitStatus,
      sessionDuration,
      claudeMdCount: configCounts.claudeMdCount,
      rulesCount: configCounts.rulesCount,
      mcpCount: configCounts.mcpCount,
      hooksCount: configCounts.hooksCount,
      activeMcps,
      effort,
      isCompressed,
      tokenStats,
      guardStatus,
      advisory,
      rates,
      compactionCount: 0,
      healthSummary,
      anomalies,
      toolCounts,
      rtkStats,
      sessionId,
      activeSessionCount,
      narrow: false, // set by renderer
    };

    render(ctx);

    // Write history with real rate_limit data (debounced: at most once per 30s per session)
    maybeWriteHistory(sessionId, usageData, tokenStats, advisory, effort, stdin, rtkStats);
  } catch (error) {
    console.log(`[claude-hud] Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    if (process.env.CLAUDE_HUD_DEBUG && error instanceof Error) {
      console.error(error.stack);
    }
  }
}

const HISTORY_DEBOUNCE_MS = 30_000;

function maybeWriteHistory(sessionId, usageData, tokenStats, advisory, effort, stdin, rtkStats) {
  try {
    // Per-session debounce marker — two concurrent sessions never
    // suppress each other's writes.
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

    writeHistoryEntry({
      sessionId,
      fiveHourPct: usageData?.fiveHour ?? null,
      sevenDayPct: usageData?.sevenDay ?? null,
      sessionBurnRate: tokenStats?.burnRate ?? 0,
      contextPct: getContextPercent(stdin),
      signal: advisory?.signal ?? 'nominal',
      model: getModelName(stdin),
      effort,
      rtkSaved: rtkStats?.totalSaved ?? null,
      rtkSavingsPct: rtkStats?.avgSavingsPct ?? null,
    });
  } catch { /* non-critical */ }
}

/**
 * Augment cached token stats with fresh stdin data.
 * stdin has current_usage from this render cycle — always fresher than daemon cache.
 * sessionStart (from transcript) is used to compute duration when daemon cache has dur=0.
 *
 * Burn rate (Phase 1.2): cost-weighted across input + output + cache_create
 * + cache_read, then expressed as output-token-equivalent tokens/min so
 * the existing `t/m` display unit still applies. EWMA-smoothed value
 * also exposed for advisor consumption.
 */
function augmentTokenStats(cached, stdin, sessionStart, modelName) {
  const usage = stdin?.context_window?.current_usage;
  if (!usage) return cached;

  const base = cached ?? {
    totalInput: 0, totalOutput: 0, totalCacheCreate: 0, totalCacheRead: 0,
    apiCalls: 0, burnRate: 0, tools: {}, mcps: {}, agentSpawns: 0, durationMin: 0,
    recentTurnsOutput: [],
  };

  // Use stdin token counts if they're larger (fresher) than cached
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const freshInput = Math.max(base.totalInput, input);
  const freshOutput = Math.max(base.totalOutput, output);
  const freshCacheCreate = Math.max(base.totalCacheCreate, cacheCreate);
  const freshCacheRead = Math.max(base.totalCacheRead, cacheRead);

  // Duration: prefer daemon cache; fall back to transcript-derived elapsed time
  const transcriptDurMin = sessionStart
    ? Math.max(1, (Date.now() - sessionStart.getTime()) / 60_000)
    : 0;
  const durationMin = base.durationMin > 0 ? base.durationMin : transcriptDurMin;

  const burnRate = costWeightedBurnRate({
    totalInput: freshInput,
    totalOutput: freshOutput,
    totalCacheCreate: freshCacheCreate,
    totalCacheRead: freshCacheRead,
    durationMin,
  }, modelName) || base.burnRate;

  const burnRateSmoothed = ewmaBurnRate(base.recentTurnsOutput, durationMin);

  return {
    ...base,
    totalInput: freshInput,
    totalOutput: freshOutput,
    totalCacheCreate: freshCacheCreate,
    totalCacheRead: freshCacheRead,
    durationMin,
    burnRate,
    burnRateSmoothed,
    burnRateModel: modelName ?? null,
  };
}

function readHealthSummary() {
  const report = readJson(HEALTH_REPORT_FILE);
  if (!report) return null;
  return { mcpFailures: report.issueCount ?? 0 };
}

function detectEffort() {
  // Check env vars first (session override)
  const env = process.env.CLAUDE_CODE_EFFORT
    ?? process.env.ANTHROPIC_EFFORT
    ?? process.env.EFFORT;
  if (env) return env.toLowerCase();

  // Read from settings.json (persisted by /effort command)
  try {
    const settingsPath = join(getClaudeConfigDir(), 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (settings.effortLevel) return settings.effortLevel.toLowerCase();
  } catch { /* ignore */ }

  return 'high';
}

// Run if invoked directly
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};

if (argvPath && isSamePath(argvPath, scriptPath)) {
  main();
}

export { main };
