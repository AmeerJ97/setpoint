import { getUsageFromStdin, getContextPercent, getSessionId, getModelName, getStatusLineCost, getContextUsage } from '../data/stdin.js';
import { isCompressionEnabled } from '../data/config.js';
import { detectRuntimeMode } from '../data/mode.js';
import { computeApiWindowRefs } from '../analytics/api-cost.js';
import { computeVertexTelemetry } from '../analytics/vertex-telemetry.js';
import { parseTranscript } from '../collectors/transcript.js';
import { countConfigs } from '../collectors/config-reader.js';
import { getGitStatus } from '../collectors/git.js';
import { readGuardStatus } from '../collectors/guard-reader.js';
import { readCachedTokenStatsMeta, getActiveMcpNames } from '../collectors/session-scanner.js';
import { readRtkStats } from '../collectors/rtk-reader.js';
import { findActiveSessions } from '../data/session.js';
import { calculateRates } from '../analytics/rates.js';
import { computeAdvisory } from '../analytics/advisor.js';
import { decide as decideEffortSwap } from '../advisor/effort-controller.js';
import { applySwap as applyEffortSwap, isAutoEffortEnabled, readLastSwap } from '../advisor/effort-writer.js';
import { runAnomalyChecks } from '../anomaly/detector.js';
import { notifyCriticalAnomalies } from '../anomaly/notify.js';
import { reversalsPer1k as reversalsPer1kRate } from '../advisor/reversals.js';
import { loadState as loadFsmState, saveState as saveFsmState } from '../advisor/fsm-controller.js';
import { analyzeIntent as analyzeSemantic, loadProfiles as loadSkillProfiles } from '../advisor/semantic-engine.js';
import { formatDuration } from '../display/format.js';
import {
  augmentTokenStats,
  computeDaemonStaleSec,
  detectEffort,
  hasApiKeyHelper,
  readHealthSummary,
} from './runtime.js';

/**
 * Build tool invocation counts keyed by tool name.
 * @param {Array<{name?: string}>} tools
 * @returns {Record<string, number>}
 */
export function buildToolCounts(tools = []) {
  const counts = {};
  for (const tool of tools) {
    const key = tool?.name;
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * Build the full render context for one HUD cycle.
 * @param {object} stdin
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 */
export async function buildRenderContext(stdin, options = {}) {
  const env = options.env ?? process.env;

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

  const sessionId = getSessionId(stdin);
  const runtimeMode = detectRuntimeMode(stdin, env, {
    apiKeyHelper: hasApiKeyHelper(),
  });
  const mode = runtimeMode.mode;

  const usageData = getUsageFromStdin(stdin);
  const statusLineCost = getStatusLineCost(stdin);
  const contextUsage = getContextUsage(stdin);
  const cachedMeta = readCachedTokenStatsMeta(sessionId);
  const modelName = getModelName(stdin);
  const tokenStats = augmentTokenStats(cachedMeta.data, stdin, transcript.sessionStart, modelName, cachedMeta.writtenAt);
  const daemonStaleSec = computeDaemonStaleSec(cachedMeta.writtenAt);
  const activeMcps = getActiveMcpNames(sessionId);
  const isCompressed = isCompressionEnabled();
  const rtkStats = readRtkStats(sessionId);
  const rtkStatus = buildRtkStatus(rtkStats, env);

  let activeSessionCount = 1;
  try { activeSessionCount = Math.max(1, findActiveSessions().length); }
  catch { /* readdir failed, default to 1 */ }

  const toolCounts = buildToolCounts(transcript.tools);
  const contextPercentForAdvisor = getContextPercent(stdin);

  const rates = calculateRates(usageData, tokenStats?.burnRate ?? 0);
  const apiWindowRefs = runtimeMode.billingSignal === "cost-metered"
    ? computeApiWindowRefs(tokenStats, modelName, undefined, {
        currentSessionId: sessionId,
        nativeSessionCostUsd: statusLineCost.costUsd,
        nativeCostAuthority: statusLineCost.authority,
      })
    : null;
  const vertexApiMaxSnapshotAgeMinutes = Number.isFinite(Number(env.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES))
    ? Number(env.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES)
    : undefined;
  const vertexTelemetry = runtimeMode.backend === "vertex-ai"
    ? computeVertexTelemetry(tokenStats, undefined, {
        currentSessionId: sessionId,
        quotaEvents: transcript.quotaEvents ?? [],
        vertexApiFile: env.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE,
        vertexApiMaxSnapshotAgeMinutes,
        env,
      })
    : null;
  const runtimeModeResolved = runtimeMode.backend === 'vertex-ai' && vertexTelemetry?.telemetryAuthority
    ? { ...runtimeMode, telemetryAuthority: vertexTelemetry.telemetryAuthority }
    : runtimeMode;

  const advisory = computeAdvisory(rates, usageData, {
    toolCounts,
    tokenStats,
    contextPercent: contextPercentForAdvisor,
    modelName,
    mode,
    runtimeMode: runtimeModeResolved,
    apiWindowRefs,
    syntheticTelemetry: vertexTelemetry,
  });

  const anomalies = detectAnomalies({
    stdin,
    transcript,
    tokenStats,
    contextPercentForAdvisor,
    guardStatus,
    toolCounts,
    modelName,
  });

  const sessionDuration = formatDuration(transcript.sessionStart)
    || (tokenStats?.durationMin ? `${tokenStats.durationMin}m` : '');

  const effort = detectEffort(env, stdin);
  const healthSummary = readHealthSummary();

  const autoEffortEnabled = isAutoEffortEnabled();
  const effortSwap = computeAutoEffortSwap({
    autoEffortEnabled,
    contextPercentForAdvisor,
    advisory,
    effort,
    modelName,
    sessionId,
  });

  attachWorkflowFsm(advisory, transcript);

  const compactionCount = (transcript.tools ?? []).filter(t => t.name === 'compact').length;

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
    contextUsage,
    guardStatus,
    advisory,
    rates,
    compactionCount,
    healthSummary,
    anomalies,
    toolCounts,
    rtkStats,
    rtkStatus,
    sessionId,
    activeSessionCount,
    daemonStaleSec,
    autoEffortEnabled,
    effortSwap,
    mode,
    authProvider: runtimeModeResolved.authProvider,
    billingSignal: runtimeModeResolved.billingSignal,
    runtimeMode: runtimeModeResolved,
    apiWindowRefs,
    vertexTelemetry,
    billingUsage: {
      costUsd: statusLineCost.costUsd ?? apiWindowRefs?.sessionCostUsd ?? null,
      authority: statusLineCost.costUsd == null ? (apiWindowRefs?.sessionCostAuthority ?? 'missing') : statusLineCost.authority,
      pricingKnown: apiWindowRefs?.pricingKnown ?? null,
      pricingModelId: apiWindowRefs?.pricingModelId ?? null,
    },
    narrow: false,
  };

  return {
    ctx,
    sessionId,
    usageData,
    tokenStats,
    advisory,
    effort,
    rtkStats,
    rtkStatus,
    runtimeMode: runtimeModeResolved,
    vertexTelemetry,
  };
}

function buildRtkStatus(rtkStats, env) {
  if (truthy(env.CLAUDE_OPS_DISABLE_RTK)) {
    return { state: 'disabled', stale: false };
  }
  if (!rtkStats) {
    return { state: 'off', stale: false };
  }
  const ageMs = rtkStats.mtimeMs ? Date.now() - rtkStats.mtimeMs : 0;
  const stale = Number.isFinite(ageMs) && ageMs > 10 * 60_000;
  if (stale) return { state: 'stale', stale: true };
  if ((rtkStats.totalSaved ?? 0) > 0) return { state: 'saving', stale: false };
  return { state: 'on', stale: false };
}

function truthy(value) {
  if (typeof value !== 'string') return Boolean(value);
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function detectAnomalies({ stdin, transcript, tokenStats, contextPercentForAdvisor, guardStatus, toolCounts, modelName }) {
  let anomalies = [];
  try {
    const currentUsage = stdin?.context_window?.current_usage ?? {};
    const revRate = reversalsPer1kRate(
      transcript.reversalCount ?? 0,
      transcript.toolCallCount ?? 0,
    );

    anomalies = runAnomalyChecks({
      outputTokens: currentUsage.output_tokens ?? 0,
      inputTokens: currentUsage.input_tokens ?? 0,
      cacheCreateTokens: currentUsage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: currentUsage.cache_read_input_tokens ?? 0,
      apiCalls: tokenStats?.apiCalls ?? 0,
      agentSpawns: tokenStats?.agentSpawns ?? 0,
      durationMin: tokenStats?.durationMin ?? 0,
      compactionCount: (transcript.tools ?? []).filter(t => t.name === 'compact').length,
      cchHashMutationCount: transcript.cchHashMutationCount ?? 0,
      contextPercent: contextPercentForAdvisor,
      guardActivationsPerHour: guardStatus?.activationsLastHour ?? 0,
      toolCounts,
      toolCallCount: transcript.toolCallCount ?? 0,
      reversalsPer1k: revRate,
      modelName,
    });

    notifyCriticalAnomalies(anomalies).catch(() => {});
  } catch {
    anomalies = [];
  }
  return anomalies;
}

function computeAutoEffortSwap({ autoEffortEnabled, contextPercentForAdvisor, advisory, effort, modelName, sessionId }) {
  if (!autoEffortEnabled) return null;
  try {
    const decision = decideEffortSwap({
      contextPct: contextPercentForAdvisor ?? 0,
      burnVelocity: advisory?.metrics?.burnVelocity ?? 1.0,
      ratio: advisory?.metrics?.ratio ?? Infinity,
      current: effort,
      modelName,
      burnP90: advisory?.baselines?.burnP90,
      confidence: advisory?.confidence,
      lastSwap: readLastSwap(),
    });
    if (!decision.target) return null;

    const applied = applyEffortSwap({
      target: decision.target,
      reason: decision.reason,
      contextPct: contextPercentForAdvisor ?? 0,
      sessionId,
      current: effort,
    });
    if (!applied.applied) return null;

    return { from: effort, to: decision.target, reason: decision.reason };
  } catch {
    return null;
  }
}

function attachWorkflowFsm(advisory, transcript) {
  try {
    const recentTools = Array.isArray(transcript?.tools) ? transcript.tools : [];
    if (recentTools.length > 0) {
      const rwRatio = advisory?.metrics?.ratio ?? Infinity;
      const completed = recentTools.filter(t => t.status === 'completed' || t.status === 'error');
      const errors = recentTools.filter(t => t.status === 'error');
      const errorDensity = completed.length > 0 ? errors.length / completed.length : 0;

      const toolText = recentTools.map(t => `${t.name ?? ''} ${t.target ?? ''}`).join(' ');
      const { topSkill, drift } = analyzeSemantic({
        text: toolText,
        profiles: loadSkillProfiles(),
      });

      const fsm = loadFsmState();
      const decision = fsm.tick({ rwRatio, errorDensity, drift });
      saveFsmState(fsm);

      if (advisory) {
        advisory.fsm = {
          state: decision.state,
          action: decision.action,
          reason: decision.reason,
          topSkill,
          drift,
          errorDensity,
        };
      }
    } else if (advisory) {
      const cold = loadFsmState();
      advisory.fsm = {
        state: cold.currentState,
        action: 'NO_ACTION',
        reason: 'no tool observations yet',
        topSkill: null,
        drift: 0,
        errorDensity: 0,
      };
    }
  } catch {
    // FSM is advisory — never fail HUD render
  }
}
