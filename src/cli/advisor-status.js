/**
 * `claude-ops advisor status` — drilldown for the live recommendation engine.
 *
 * Parallels `claude-ops guard status`. Renders the same Recommendation the
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
import { createHash } from 'node:crypto';
import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE, DAILY_REPORT_FILE, VERTEX_API_TELEMETRY_FILE } from '../data/paths.js';
import { computeAdvisory } from '../analytics/advisor.js';
import { calculateRates } from '../analytics/rates.js';
import { computeBaselines } from '../advisor/baselines.js';
import { computePeakSplit } from '../advisor/peak-split.js';
import { scanReversalsForActiveSessions } from '../advisor/index.js';
import { reversalsPer1k } from '../advisor/reversals.js';
import { computeApiWindowRefs } from '../analytics/api-cost.js';
import { computeVertexTelemetry } from '../analytics/vertex-telemetry.js';
import { runtimeBackend, runtimeBackendLabel, runtimeTelemetryAuthority } from '../data/mode.js';
import { filterTrustedHistoryRows, latestTrustedHistoryRow } from '../data/history-safety.js';

const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

const TIER_COLOR = {
  hard_stop_5h: RED, hard_stop_7d: RED, limit_hit: RED,
  vertex_quota_exhausted: RED,
  model_swap: YELLOW, clear_session: YELLOW, compact_context: YELLOW,
  vertex_burn_high: YELLOW,
  ok: GREEN, no_data: DIM,
};

/**
 * Assemble everything the drilldown needs. Pure data — formatting lives in
 * the renderers so tests can target the shape.
 */
export function collectAdvisorState() {
  const history30dRaw = safeHistory(30 * 86_400_000);
  const history7dRaw  = safeHistory(7  * 86_400_000);
  const history30d = filterTrustedHistoryRows(history30dRaw);
  const history7d = filterTrustedHistoryRows(history7dRaw);
  const latest = latestTrustedHistoryRow(history30dRaw);

  // Reconstruct the snapshot the live HUD would have produced from the
  // most recent history row. Honestly named `latestSnapshot` — the old
  // daily-report used the same approach and called the local `fakeUsage`
  // which misled readers into thinking it was a mock.
  let recommendation = null;
  let rates = null;
  let runtimeMode = null;
  let apiWindowRefs = null;
  let vertexTelemetry = null;
  if (latest) {
    runtimeMode = runtimeModeFromHistory(latest);
    const isQuotaWindow = latest.billing_signal === 'quota-window'
      && (latest.five_hour_pct != null || latest.seven_day_pct != null);
    const latestSnapshot = isQuotaWindow ? {
      fiveHour: latest.five_hour_pct ?? null,
      sevenDay: latest.seven_day_pct ?? null,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
    } : null;
    rates = calculateRates(latestSnapshot, latest.session_burn_rate ?? 0);
    const tokenStats = tokenStatsFromHistory(latest);
    apiWindowRefs = runtimeMode.billingSignal === 'cost-metered'
      ? computeApiWindowRefs(tokenStats, latest.model ?? null, history30d, { currentSessionId: latest.session_id ?? null })
      : null;
    vertexTelemetry = runtimeMode.backend === 'vertex-ai'
      ? computeVertexTelemetry(tokenStats, history30d, { currentSessionId: latest.session_id ?? null })
      : null;
    const runtimeModeResolved = runtimeMode.backend === 'vertex-ai' && vertexTelemetry?.telemetryAuthority
      ? { ...runtimeMode, telemetryAuthority: vertexTelemetry.telemetryAuthority }
      : runtimeMode;
    recommendation = computeAdvisory(rates, latestSnapshot, {
      history: history30d,
      tokenStats,
      contextPercent: latest.context_pct ?? null,
      modelName: latest.model ?? null,
      toolCounts: {},
      mode: runtimeModeResolved.mode,
      runtimeMode: runtimeModeResolved,
      apiWindowRefs,
      syntheticTelemetry: vertexTelemetry,
    });
    runtimeMode = runtimeModeResolved;
  }

  const baselines = computeBaselines(history30d);
  const peakSplit = computePeakSplit(history7d);
  const reversals = safeReversals();
  const reportTail = readReportTail(25);
  const configuredVertexApiFile = process.env.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE ?? VERTEX_API_TELEMETRY_FILE;
  const vertexSource = buildVertexSource(vertexTelemetry, configuredVertexApiFile);

  const hasData = Boolean(latest);
  const resolvedRecommendation = recommendation ?? {
    signal: 'nominal',
    reason: 'no usage-history rows in the last 7 days',
    action: 'no recent history — start a session to generate one',
    causalReason: 'no usage-history rows in the last 7 days',
    confidence: 'low',
    confidenceWhy: 'no trusted usage-history rows available',
    tier: 'no_data',
    suggestion: { effort: 'high', model: 'opus' },
    fiveHour: null,
    sevenDay: null,
    burnRate: 0,
    burnLevel: 'low',
    estimatedSessions: 0,
    metrics: {},
    baselines,
    backend: null,
    telemetryAuthority: null,
    syntheticTelemetry: null,
  };

  return {
    generatedAt: new Date().toISOString(),
    hasData,
    latestSample: latest,
    runtimeMode,
    backendBadge: runtimeMode ? runtimeBackendLabel(runtimeMode) : null,
    apiWindowRefs,
    vertexTelemetry,
    vertexSource,
    recommendation: resolvedRecommendation,
    baselines,
    peakSplit,
    reversals,
    reportTail,
  };
}

export function renderTable(state) {
  const lines = [];
  lines.push(`${BOLD}claude-ops advisor status${RESET}`);
  lines.push('');

  if (!state.hasData) {
    lines.push(`${DIM}no usage history yet — start a session to populate the engine${RESET}`);
    return lines.join('\n');
  }

  const rec = state.recommendation;
  const tierColor = TIER_COLOR[rec.tier] ?? RESET;
  lines.push(`${BOLD}Current call${RESET}`);
  if (state.runtimeMode) {
    lines.push(`  backend   ${CYAN}${state.backendBadge}${RESET} ${DIM}(${state.runtimeMode.telemetryAuthority})${RESET}`);
  }
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
  if (state.vertexTelemetry) {
    const apiBacked = state.vertexTelemetry.telemetryAuthority === 'vertex-api';
    lines.push(`  vertex 5h ${apiBacked ? 'api' : 'est'}   ${fmtN(state.vertexTelemetry.fiveHour.totalTokens)} tokens ${DIM}(${state.vertexTelemetry.fiveHour.sessions} sessions)${RESET}`);
    lines.push(`  vertex 7d ${apiBacked ? 'api' : 'est'}   ${fmtN(state.vertexTelemetry.sevenDay.totalTokens)} tokens ${DIM}(${state.vertexTelemetry.dataMaturity.state})${RESET}`);
    if (state.vertexSource) {
      lines.push(`  vertex src      ${state.vertexSource.authoritative ? 'authoritative' : 'fallback'} ${DIM}(${state.vertexSource.authority})${RESET}`);
      if (state.vertexSource.retrievedAt) {
        lines.push(`  vertex at       ${DIM}${state.vertexSource.retrievedAt}${RESET}`);
      }
      if (state.vertexSource.fingerprint) {
        lines.push(`  vertex fp       ${DIM}${state.vertexSource.fingerprint}${RESET}`);
      }
      if (state.vertexSource.reason) {
        lines.push(`  vertex note     ${DIM}${state.vertexSource.reason}${RESET}`);
      }
    }
    if (state.vertexTelemetry.latestQuotaEvent) {
      lines.push(`  quota event     ${RED}${state.vertexTelemetry.latestQuotaEvent.code}${RESET} ${DIM}(${state.vertexTelemetry.latestQuotaEvent.causalReason})${RESET}`);
    }
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
    lines.push(`${DIM}no daily-report.md yet — run \`claude-ops advisor\` to generate one${RESET}`);
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

function runtimeModeFromHistory(row) {
  const authProvider = row.auth_provider ?? 'unknown';
  const billingSignal = row.billing_signal ?? (row.five_hour_pct != null || row.seven_day_pct != null ? 'quota-window' : 'cost-metered');
  const backend = row.backend ?? runtimeBackend(authProvider, billingSignal);
  const telemetryAuthority = row.telemetry_authority ?? runtimeTelemetryAuthority(backend, billingSignal);
  return {
    authProvider,
    billingSignal,
    mode: row.mode ?? (billingSignal === 'quota-window' ? 'max' : authProvider === 'bedrock' ? 'bedrock' : 'api'),
    backend,
    telemetryAuthority,
    backendLabel: runtimeBackendLabel({ backend, authProvider, billingSignal }),
  };
}

function tokenStatsFromHistory(row) {
  return {
    burnRate: row.session_burn_rate ?? 0,
    durationMin: row.duration_min ?? 0,
    recentTurnsOutput: inferRecentTurnsOutputFromHistoryRow(row),
    totalInput: row.input_tokens ?? 0,
    totalOutput: row.output_tokens ?? 0,
    totalCacheCreate: row.cache_create_tokens ?? 0,
    totalCacheRead: row.cache_read_tokens ?? 0,
    apiCalls: row.api_calls ?? 0,
  };
}

function inferRecentTurnsOutputFromHistoryRow(row) {
  const rawTurns = row.recent_turn_count
    ?? row.turn_count
    ?? row.turns
    ?? row.api_calls
    ?? 0;
  const count = Math.max(0, Math.floor(Number(rawTurns) || 0));
  const capped = Math.min(count, 200);
  return Array(capped).fill(1);
}

function buildVertexSource(vertexTelemetry, configuredVertexApiFile) {
  if (!vertexTelemetry) return null;
  const authority = vertexTelemetry.telemetryAuthority ?? 'unknown';
  const authoritative = authority === 'vertex-api';
  const sourceFile = vertexTelemetry.apiTelemetryFile ?? configuredVertexApiFile ?? null;
  const retrievedAt = authoritative ? (vertexTelemetry.retrievedAt ?? null) : null;
  const reason = authoritative ? null : (vertexTelemetry.apiTelemetryReason ?? null);
  const fingerprint = authoritative ? vertexSnapshotFingerprint(vertexTelemetry) : null;
  return {
    authority,
    authoritative,
    sourceFile,
    retrievedAt,
    fingerprint,
    reason,
  };
}

function vertexSnapshotFingerprint(telemetry) {
  const payload = {
    retrievedAt: telemetry.retrievedAt ?? null,
    fiveHour: {
      inputTokens: telemetry.fiveHour?.inputTokens ?? null,
      outputTokens: telemetry.fiveHour?.outputTokens ?? null,
      totalTokens: telemetry.fiveHour?.totalTokens ?? null,
      costUsd: telemetry.fiveHour?.costUsd ?? telemetry.fiveHour?.estimatedCostUsd ?? null,
      apiCalls: telemetry.fiveHour?.apiCalls ?? null,
    },
    sevenDay: {
      inputTokens: telemetry.sevenDay?.inputTokens ?? null,
      outputTokens: telemetry.sevenDay?.outputTokens ?? null,
      totalTokens: telemetry.sevenDay?.totalTokens ?? null,
      costUsd: telemetry.sevenDay?.costUsd ?? telemetry.sevenDay?.estimatedCostUsd ?? null,
      apiCalls: telemetry.sevenDay?.apiCalls ?? null,
    },
    quota: {
      code: telemetry.latestQuotaEvent?.code ?? null,
      status: telemetry.latestQuotaEvent?.status ?? null,
      ts: telemetry.latestQuotaEvent?.ts ?? null,
    },
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
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
