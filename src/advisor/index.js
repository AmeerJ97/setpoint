#!/usr/bin/env node
/**
 * Daily advisor — produces actionable recommendations.
 * Writes markdown report to ~/.claude/plugins/claude-hud/daily-report.md.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { readJsonl, readJsonlWindow, readJson } from '../data/jsonl.js';
import { HISTORY_FILE, TOKEN_STATS_FILE, DAILY_REPORT_FILE, PLUGIN_DIR, RTK_STATS_FILE } from '../data/paths.js';
import { analyzeEfficiency } from './analyses/efficiency.js';
import { analyzeTopConsumers } from './analyses/top-consumers.js';
import { analyzeEffortMatrix } from './analyses/effort-matrix.js';
import { analyzeWeeklyTrend } from './analyses/weekly-trend.js';
import { analyzeRtkEfficiency } from './analyses/rtk-efficiency.js';
import { readRtkStats } from '../collectors/rtk-reader.js';
import { readGuardStatus } from '../collectors/guard-reader.js';

async function generateReport() {
  const sessions = readJsonlWindow(TOKEN_STATS_FILE, 7 * 86400_000);
  const history = readJsonlWindow(HISTORY_FILE, 7 * 86400_000);
  const rtkStats = readRtkStats();
  const guardStatus = await readGuardStatus();

  const efficiency = analyzeEfficiency(sessions);
  const topConsumers = analyzeTopConsumers(sessions);
  const effortMatrix = analyzeEffortMatrix(history, rtkStats);
  const trend = analyzeWeeklyTrend(history, sessions);
  const rtkAnalysis = analyzeRtkEfficiency(rtkStats);

  const lines = [
    `# Daily Advisor Report`,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    `> **${effortMatrix.effort}/${effortMatrix.model}** — ${effortMatrix.summary}`,
    '',
    `## Budget Status`,
    `- ${efficiency.summary}`,
    `- ${trend.summary}`,
    effortMatrix.costNote ? `- ${effortMatrix.costNote}` : null,
    '',
    `## RTK Impact`,
    `- ${rtkAnalysis.summary}`,
    ...rtkAnalysis.details.map(d => `  - ${d}`),
    '',
    `## Top Consumers (7 days)`,
    ...topConsumers.top.map((t, i) => `${i + 1}. ${t.project}: ${formatK(t.tokens)} tokens`),
    '',
    `## Guard Status`,
    `- Service: ${guardStatus.running ? 'active' : 'DOWN'}`,
    `- Activations today: ${guardStatus.activationsToday ?? 0}`,
    guardStatus.lastFlag ? `- Last override: ${guardStatus.lastFlag}` : null,
    '',
    `## Recommendation`,
    `**Effort:** ${effortMatrix.effort} | **Model:** ${effortMatrix.model}`,
    '',
    `## Trend`,
    `Direction: ${trend.trend}${trend.changePct ? ` (${trend.changePct > 0 ? '+' : ''}${trend.changePct}%)` : ''}`,
  ].filter(l => l !== null);

  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(DAILY_REPORT_FILE, lines.join('\n'));
  console.log(`[daily-advisor] Report generated: ${DAILY_REPORT_FILE}`);
}

function formatK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}

// Run if invoked directly
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
if (argvPath) {
  try { if (realpathSync(argvPath) === realpathSync(scriptPath)) generateReport(); }
  catch { if (argvPath === scriptPath) generateReport(); }
}

export { generateReport };
