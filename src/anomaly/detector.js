#!/usr/bin/env node
/**
 * Anomaly detector — checks rules and logs alerts.
 * Can run standalone or be called from the analytics daemon.
 */
import { appendJsonl, rotateJsonl } from '../data/jsonl.js';
import { ANOMALY_LOG_FILE, ROTATION } from '../data/paths.js';
import { checkTokenSpike } from './rules/token-spike.js';
import { checkRunawayAgent } from './rules/runaway-agent.js';
import { checkContextThrash } from './rules/context-thrash.js';
import { checkStaleSession } from './rules/stale-session.js';
import { checkGrowthBookEscalation } from './rules/growthbook-escalation.js';
import { checkBackgroundDrain } from './rules/background-drain.js';
import { checkReadEditRatio } from './rules/read-edit-ratio.js';
import { checkContextPressure } from './rules/context-pressure.js';
import { checkToolDiversity } from './rules/tool-diversity.js';
import { checkSessionEfficiency } from './rules/session-efficiency.js';
import { checkMcpFailures } from './rules/mcp-failure.js';

/**
 * Run all anomaly checks against session data.
 * @param {object} sessionData
 * @returns {Array<{triggered: boolean, message: string, severity?: string}>}
 */
export function runAnomalyChecks(sessionData) {
  const alerts = [];

  const spike = checkTokenSpike(sessionData);
  if (spike) alerts.push(spike);

  const runaway = checkRunawayAgent(sessionData.agentSpawns ?? 0, sessionData.durationMin ?? 0);
  if (runaway) alerts.push(runaway);

  const thrash = checkContextThrash(sessionData.compactionCount ?? 0);
  if (thrash) alerts.push(thrash);

  const stale = checkStaleSession(sessionData.durationMin ?? 0, sessionData.compactionCount ?? 0);
  if (stale) alerts.push(stale);

  const gbEscalation = checkGrowthBookEscalation(sessionData.guardActivationsPerHour ?? 0);
  if (gbEscalation) alerts.push(gbEscalation);

  // Read:Edit ratio check
  const reRatio = checkReadEditRatio(sessionData);
  if (reRatio?.triggered) alerts.push(reRatio);

  // Context pressure check (proactive warning before compaction)
  const pressure = checkContextPressure({
    contextPercent: sessionData.contextPercent,
    compactionCount: sessionData.compactionCount,
  });
  if (pressure) alerts.push(pressure);

  // Tool diversity check (detect shallow tool usage)
  const diversity = checkToolDiversity({ toolCounts: sessionData.toolCounts });
  if (diversity) alerts.push(diversity);

  // Session efficiency check (output/input ratio)
  const efficiency = checkSessionEfficiency({
    inputTokens: sessionData.inputTokens,
    outputTokens: sessionData.outputTokens,
    cacheReadTokens: sessionData.cacheReadTokens,
  });
  if (efficiency) alerts.push(efficiency);

  // MCP failure streak check
  if (sessionData.mcpFailureCounts) {
    const mcpAlerts = checkMcpFailures(sessionData.mcpFailureCounts);
    for (const a of mcpAlerts) {
      if (a.triggered) alerts.push(a);
    }
  }

  // Background drain checks (Cowork, chrome hosts, Desktop agents)
  try {
    const bgAlerts = checkBackgroundDrain();
    for (const a of bgAlerts) {
      if (a.triggered) alerts.push(a);
    }
  } catch { /* don't crash HUD if bg check fails */ }

  // Log triggered alerts
  for (const alert of alerts) {
    if (alert.triggered) {
      appendJsonl(ANOMALY_LOG_FILE, {
        ts: new Date().toISOString(),
        ...alert,
      });
    }
  }

  // Rotate anomaly log if oversized
  rotateJsonl(ANOMALY_LOG_FILE, ROTATION.ANOMALY_LOG.maxBytes, ROTATION.ANOMALY_LOG.keepLines);

  return alerts.filter(a => a.triggered);
}
