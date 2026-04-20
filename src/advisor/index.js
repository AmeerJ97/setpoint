#!/usr/bin/env node
/**
 * Daily advisor — produces actionable recommendations.
 *
 * Phase 2: replaces the static effort-matrix ladder with the new engine
 * + adds reasoning-reversals scan + P90 baselines + peak-vs-off-peak
 * burn split. Writes markdown report to ~/.claude/plugins/claude-hud/daily-report.md.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { readJsonl, readJsonlWindow, readJson } from '../data/jsonl.js';
import { HISTORY_FILE, TOKEN_STATS_FILE, DAILY_REPORT_FILE, PLUGIN_DIR, RTK_STATS_FILE } from '../data/paths.js';
import { analyzeEfficiency } from './analyses/efficiency.js';
import { analyzeTopConsumers } from './analyses/top-consumers.js';
import { analyzeWeeklyTrend } from './analyses/weekly-trend.js';
import { analyzeRtkEfficiency } from './analyses/rtk-efficiency.js';
import { readRtkStats } from '../collectors/rtk-reader.js';
import { readGuardStatus } from '../collectors/guard-reader.js';
import { computeBaselines } from './baselines.js';
import { countReasoningReversals, reversalsPer1k } from './reversals.js';
import { calculateRates } from '../analytics/rates.js';
import { computeAdvisory } from '../analytics/advisor.js';
import { findActiveSessions, findSessionJsonl } from '../data/session.js';
import { getRatesTuning } from '../data/defaults.js';

async function generateReport() {
  const sessions = readJsonlWindow(TOKEN_STATS_FILE, 7 * 86400_000);
  const history30d = readJsonlWindow(HISTORY_FILE, 30 * 86400_000);
  const history7d = readJsonlWindow(HISTORY_FILE, 7 * 86400_000);
  const rtkStats = readRtkStats();
  const guardStatus = await readGuardStatus();

  const efficiency = analyzeEfficiency(sessions);
  const topConsumers = analyzeTopConsumers(sessions);
  const trend = analyzeWeeklyTrend(history7d, sessions);
  const rtkAnalysis = analyzeRtkEfficiency(rtkStats);

  const baselines = computeBaselines(history30d);
  const peakSplit = computePeakSplit(history7d);
  const reversals = scanReversalsForActiveSessions();

  // Build a synthetic "current" advisory off the most recent history
  // entry so the daily report reflects the same recommendation engine
  // the live HUD uses.
  const latest = history7d[history7d.length - 1] ?? null;
  const recommendation = synthesizeRecommendation(latest, history30d);

  const lines = [
    `# Daily Advisor Report`,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    `> **${recommendation.action}** (${recommendation.confidence} confidence)`,
    `> ${recommendation.causalReason}`,
    '',
    `## Budget Status`,
    `- ${efficiency.summary}`,
    `- ${trend.summary}`,
    '',
    `## P90 Baselines (${baselines.sufficient ? `${Math.round(baselines.daysSpanned)}d, ${baselines.samples} samples` : 'insufficient data'})`,
    baselines.sufficient
      ? `- Burn rate — P50: ${fmt(baselines.burnP50)} t/m · P90: ${fmt(baselines.burnP90)} t/m`
      : `- Need ≥7 days of history for personal baselining (have ${Math.round(baselines.daysSpanned)}d, ${baselines.samples} samples)`,
    baselines.sufficient && baselines.contextP90 != null
      ? `- Context % — P50: ${Math.round(baselines.contextP50)}% · P90: ${Math.round(baselines.contextP90)}%`
      : null,
    '',
    `## Peak vs Off-Peak Burn (7d)`,
    `- Peak: ${fmt(peakSplit.peakAvg)} t/m avg over ${peakSplit.peakSamples} samples`,
    `- Off-peak: ${fmt(peakSplit.offPeakAvg)} t/m avg over ${peakSplit.offPeakSamples} samples`,
    peakSplit.ratio !== null
      ? `- Ratio: ${peakSplit.ratio.toFixed(2)}× (${peakSplit.ratio > 1.5 ? 'peak inflates burn — schedule heavy work off-peak' : 'roughly even'})`
      : null,
    '',
    `## RTK Impact`,
    `- ${rtkAnalysis.summary}`,
    ...rtkAnalysis.details.map(d => `  - ${d}`),
    '',
    `## Top Consumers (7 days)`,
    ...topConsumers.top.map((t, i) => `${i + 1}. ${t.project}: ${formatK(t.tokens)} tokens`),
    '',
    `## Reasoning Reversals (active sessions, last 24h)`,
    reversals.totalCalls === 0
      ? `- No active session transcripts found.`
      : `- ${reversals.totalReversals} reversals over ${reversals.totalCalls} tool calls (${reversalsPer1k(reversals.totalReversals, reversals.totalCalls).toFixed(1)} per 1k calls)`,
    reversals.flagged.length > 0
      ? `- ⚠ Sessions exceeding 25 reversals/1k calls:`
      : null,
    ...reversals.flagged.map(s =>
      `  - ${basename(s.path)}: ${s.reversals}/${s.toolCalls} (${s.ratePer1k.toFixed(1)}/1k)`
    ),
    '',
    `## Guard Status`,
    `- Service: ${guardStatus.running ? 'active' : 'DOWN'}`,
    `- Activations today: ${guardStatus.activationsToday ?? 0}`,
    guardStatus.lastFlag ? `- Last override: ${guardStatus.lastFlag}` : null,
    '',
    `## Recommendation Detail`,
    `**Tier:** ${recommendation.tier}`,
    `**Suggested:** effort=${recommendation.suggestion?.effort ?? 'high'}, model=${recommendation.suggestion?.model ?? 'opus'}`,
    '',
    `## Trend`,
    `Direction: ${trend.trend}${trend.changePct ? ` (${trend.changePct > 0 ? '+' : ''}${trend.changePct}%)` : ''}`,
  ].filter(l => l !== null);

  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(DAILY_REPORT_FILE, lines.join('\n'));
  console.log(`[daily-advisor] Report generated: ${DAILY_REPORT_FILE}`);
}

/**
 * Re-run the engine with the latest history snapshot so the daily
 * report's headline matches what the live HUD is showing.
 */
function synthesizeRecommendation(latestEntry, history) {
  if (!latestEntry) {
    return {
      action: 'no recent history — start a session to generate one',
      confidence: 'low',
      causalReason: 'no usage-history rows in the last 7 days',
      tier: 'no_data',
      suggestion: { effort: 'high', model: 'opus' },
    };
  }
  const fakeUsage = {
    fiveHour: latestEntry.five_hour_pct ?? 0,
    sevenDay: latestEntry.seven_day_pct ?? 0,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
  };
  const rates = calculateRates(fakeUsage, latestEntry.session_burn_rate ?? 0);
  const adv = computeAdvisory(rates, fakeUsage, {
    history,
    tokenStats: { burnRate: latestEntry.session_burn_rate ?? 0 },
    contextPercent: latestEntry.context_pct ?? null,
    modelName: latestEntry.model ?? null,
    toolCounts: {},
  });
  return adv;
}

/**
 * Split the trailing-week burn-rate samples by whether they fell in
 * the configured peak window (default 5–11 PT) and compute the ratio.
 */
function computePeakSplit(history) {
  const peak = getRatesTuning().peakHours;
  if (!peak.enabled) {
    return { peakAvg: 0, offPeakAvg: 0, peakSamples: 0, offPeakSamples: 0, ratio: null };
  }
  let peakSum = 0, offSum = 0, peakN = 0, offN = 0;
  for (const e of history) {
    if (!e.ts || !Number.isFinite(e.session_burn_rate)) continue;
    const hour = localHour(new Date(e.ts).getTime(), peak.timezone);
    const inPeak = peak.startHour < peak.endHour
      ? hour >= peak.startHour && hour < peak.endHour
      : hour >= peak.startHour || hour < peak.endHour;
    if (inPeak) { peakSum += e.session_burn_rate; peakN++; }
    else        { offSum  += e.session_burn_rate; offN++;  }
  }
  const peakAvg = peakN > 0 ? peakSum / peakN : 0;
  const offPeakAvg = offN > 0 ? offSum / offN : 0;
  const ratio = offPeakAvg > 0 ? peakAvg / offPeakAvg : null;
  return { peakAvg, offPeakAvg, peakSamples: peakN, offPeakSamples: offN, ratio };
}

function localHour(epochMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    });
    const h = parseInt(fmt.format(new Date(epochMs)), 10);
    return Number.isFinite(h) ? (h === 24 ? 0 : h) : 0;
  } catch {
    return new Date(epochMs).getUTCHours();
  }
}

/**
 * Walk recently-active session JSONLs and tally reversal phrases in
 * assistant text. Out-of-scope sessions (older than 24h, missing files)
 * are skipped silently.
 */
function scanReversalsForActiveSessions() {
  const cutoff = Date.now() - 24 * 3600_000;
  let totalReversals = 0;
  let totalCalls = 0;
  const flagged = [];

  let active;
  try { active = findActiveSessions(); }
  catch { active = []; }

  for (const session of active) {
    const located = session.sessionId ? findSessionJsonl(session.sessionId) : null;
    const path = located?.path;
    if (!path || !existsSync(path)) continue;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.mtimeMs < cutoff) continue;

    let text = '';
    let toolCalls = 0;
    try {
      const content = readFileSync(path, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const blocks = entry.message?.content;
          if (!Array.isArray(blocks)) continue;
          for (const b of blocks) {
            if (b.type === 'text' && typeof b.text === 'string') text += b.text + '\n';
            if (b.type === 'tool_use') toolCalls++;
          }
        } catch { /* skip malformed lines */ }
      }
    } catch { continue; }

    const reversals = countReasoningReversals(text);
    totalReversals += reversals;
    totalCalls += toolCalls;

    const ratePer1k = reversalsPer1k(reversals, toolCalls);
    if (ratePer1k > 25) flagged.push({ path, reversals, toolCalls, ratePer1k });
  }

  return { totalReversals, totalCalls, flagged };
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  return Math.round(n).toString();
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

export { generateReport, computePeakSplit, scanReversalsForActiveSessions };
