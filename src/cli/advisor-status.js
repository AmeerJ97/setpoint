/**
 * `setpoint advisor status` — drilldown for the live recommendation engine.
 *
 * Parallels `setpoint guard status`. Renders the same Recommendation the
 * HUD renders on the Advisor line, plus the metrics and baselines the HUD
 * can't afford to show (peak split, reversals-per-1k, P50/P90 baselines,
 * the tail of the most-recent daily-report.md).
 *
 * Data sources:
 *   • Live engine output       → src/analytics/advisor.computeAdvisory
 *   • 30d personal baselines   → src/advisor/baselines.computeBaselines
 *   • Peak vs off-peak burn    → src/advisor/peak-split.computePeakSplit
 *   • Reversals over tool-use  → src/advisor/reversals
 *   • Usage-history (latest)   → usage-history.jsonl
 *   • Daily report tail        → daily-report.md
 *
 * Exits zero on success. `--json` emits a machine-readable schema.
 */
import { readFileSync, existsSync } from 'node:fs';
import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE, DAILY_REPORT_FILE } from '../data/paths.js';
import { computeAdvisory } from '../analytics/advisor.js';
import { calculateRates } from '../analytics/rates.js';
import { computeBaselines } from '../advisor/baselines.js';
import { computePeakSplit } from '../advisor/peak-split.js';
import { scanReversalsForActiveSessions } from '../advisor/index.js';
import { reversalsPer1k } from '../advisor/reversals.js';

const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

const TIER_COLOR = {
  hard_stop_5h: RED, hard_stop_7d: RED, limit_hit: RED,
  model_swap: YELLOW, clear_session: YELLOW, compact_context: YELLOW,
  ok: GREEN, no_data: DIM,
};

/**
 * Assemble everything the drilldown needs. Pure data — formatting lives in
 * the renderers so tests can target the shape.
 */
export function collectAdvisorState() {
  const history30d = safeHistory(30 * 86_400_000);
  const history7d  = safeHistory(7  * 86_400_000);
  const latest = history30d[history30d.length - 1] ?? null;

  // Reconstruct the snapshot the live HUD would have produced from the
  // most recent history row. Honestly named `latestSnapshot` — the old
  // daily-report used the same approach and called the local `fakeUsage`
  // which misled readers into thinking it was a mock.
  let recommendation = null;
  let rates = null;
  if (latest) {
    const latestSnapshot = {
      fiveHour: latest.five_hour_pct ?? 0,
      sevenDay: latest.seven_day_pct ?? 0,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
    };
    rates = calculateRates(latestSnapshot, latest.session_burn_rate ?? 0);
    recommendation = computeAdvisory(rates, latestSnapshot, {
      history: history30d,
      tokenStats: { burnRate: latest.session_burn_rate ?? 0 },
      contextPercent: latest.context_pct ?? null,
      modelName: latest.model ?? null,
      toolCounts: {},
    });
  }

  const baselines = computeBaselines(history30d);
  const peakSplit = computePeakSplit(history7d);
  const reversals = safeReversals();
  const reportTail = readReportTail(25);

  return {
    generatedAt: new Date().toISOString(),
    hasData: Boolean(latest),
    latestSample: latest,
    recommendation,
    baselines,
    peakSplit,
    reversals,
    reportTail,
  };
}

export function renderTable(state) {
  const lines = [];
  lines.push(`${BOLD}setpoint advisor status${RESET}`);
  lines.push('');

  if (!state.hasData) {
    lines.push(`${DIM}no usage history yet — start a session to populate the engine${RESET}`);
    return lines.join('\n');
  }

  const rec = state.recommendation;
  const tierColor = TIER_COLOR[rec.tier] ?? RESET;
  lines.push(`${BOLD}Current call${RESET}`);
  lines.push(`  tier      ${tierColor}${rec.tier}${RESET}`);
  lines.push(`  action    ${tierColor}${rec.action}${RESET}`);
  lines.push(`  signal    ${rec.signal}`);
  lines.push(`  confidence ${colorConfidence(rec.confidence)} ${DIM}(${rec.confidenceWhy})${RESET}`);
  lines.push(`  reason    ${DIM}${rec.causalReason}${RESET}`);
  lines.push('');

  lines.push(`${BOLD}Metrics${RESET}`);
  const m = rec.metrics ?? {};
  lines.push(`  burn rate       ${fmtN(m.burnRate)} t/m`);
  if (Number.isFinite(m.burnVelocity)) {
    lines.push(`  burn vs P50     ${fmtRatio(m.burnVelocity)}×`);
  }
  if (Number.isFinite(m.ratio)) {
    lines.push(`  R:E ratio       ${fmtRatio(m.ratio)} ${DIM}(${m.reads ?? 0}r/${m.edits ?? 0}e)${RESET}`);
  }
  if (m.peakActive != null) {
    lines.push(`  peak active     ${m.peakActive ? `${YELLOW}yes${RESET}` : 'no'}`);
  }
  if (Number.isFinite(m.contextPercent)) {
    lines.push(`  context used    ${Math.round(m.contextPercent)}%`);
  }
  lines.push('');

  lines.push(`${BOLD}P50/P90 Baselines (30d)${RESET}`);
  if (rec.baselines?.sufficient) {
    lines.push(`  burn P50 / P90  ${fmtN(rec.baselines.burnP50)} / ${fmtN(rec.baselines.burnP90)} t/m`);
    if (rec.baselines.contextP90 != null) {
      lines.push(`  context P50/P90 ${Math.round(rec.baselines.contextP50)}% / ${Math.round(rec.baselines.contextP90)}%`);
    }
    lines.push(`  samples         ${rec.baselines.samples} over ${Math.round(rec.baselines.daysSpanned)}d`);
  } else {
    lines.push(`  ${DIM}insufficient history (have ${rec.baselines?.samples ?? 0} samples, need ≥7d)${RESET}`);
  }
  lines.push('');

  lines.push(`${BOLD}Peak vs Off-Peak (7d)${RESET}`);
  if (state.peakSplit.peakSamples + state.peakSplit.offPeakSamples === 0) {
    lines.push(`  ${DIM}no samples yet${RESET}`);
  } else {
    lines.push(`  peak avg        ${fmtN(state.peakSplit.peakAvg)} t/m (${state.peakSplit.peakSamples} samples)`);
    lines.push(`  off-peak avg    ${fmtN(state.peakSplit.offPeakAvg)} t/m (${state.peakSplit.offPeakSamples} samples)`);
    if (state.peakSplit.ratio != null) {
      const ratioColor = state.peakSplit.ratio > 1.5 ? YELLOW : DIM;
      lines.push(`  ratio           ${ratioColor}${state.peakSplit.ratio.toFixed(2)}×${RESET}`);
    }
  }
  lines.push('');

  lines.push(`${BOLD}Reasoning Reversals (active sessions, last 24h)${RESET}`);
  if (state.reversals.totalCalls === 0) {
    lines.push(`  ${DIM}no active session transcripts${RESET}`);
  } else {
    const rate = reversalsPer1k(state.reversals.totalReversals, state.reversals.totalCalls);
    const color = rate > 25 ? RED : rate > 10 ? YELLOW : GREEN;
    lines.push(`  ${color}${state.reversals.totalReversals}${RESET} reversals / ${state.reversals.totalCalls} tool calls ${DIM}(${color}${rate.toFixed(1)}/1k${RESET}${DIM})${RESET}`);
    for (const s of state.reversals.flagged) {
      lines.push(`  ${DIM}↳ ${s.path}: ${s.reversals}/${s.toolCalls} (${s.ratePer1k.toFixed(1)}/1k)${RESET}`);
    }
  }
  lines.push('');

  if (state.reportTail) {
    lines.push(`${BOLD}Last daily-report.md (tail)${RESET}`);
    for (const l of state.reportTail.split('\n')) {
      lines.push(`  ${DIM}${l}${RESET}`);
    }
  } else {
    lines.push(`${DIM}no daily-report.md yet — run \`setpoint advisor\` to generate one${RESET}`);
  }

  return lines.join('\n');
}

export function renderJson(state) {
  return JSON.stringify(state, null, 2);
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const state = collectAdvisorState();
  process.stdout.write(json ? renderJson(state) + '\n' : renderTable(state) + '\n');
  return 0;
}

/* ----------------------------------------------------------------------- */

function safeHistory(windowMs) {
  try { return readJsonlWindow(HISTORY_FILE, windowMs); }
  catch { return []; }
}

function safeReversals() {
  try { return scanReversalsForActiveSessions(); }
  catch { return { totalReversals: 0, totalCalls: 0, flagged: [] }; }
}

function readReportTail(maxLines) {
  try {
    if (!existsSync(DAILY_REPORT_FILE)) return null;
    const text = readFileSync(DAILY_REPORT_FILE, 'utf8');
    const all = text.split('\n');
    return all.slice(Math.max(0, all.length - maxLines)).join('\n');
  } catch { return null; }
}

function fmtN(n) {
  if (!Number.isFinite(n)) return '–';
  return Math.round(n).toString();
}
function fmtRatio(n) {
  if (!Number.isFinite(n)) return '–';
  return n.toFixed(2);
}
function colorConfidence(c) {
  if (c === 'high') return `${GREEN}high${RESET}`;
  if (c === 'med' || c === 'medium') return `${YELLOW}${c}${RESET}`;
  return `${DIM}${c ?? '--'}${RESET}`;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main());
}
