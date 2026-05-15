#!/usr/bin/env node
/**
 * `claude-ops usage` — read-only local usage ledger.
 *
 * This command summarizes Claude Ops' local usage-history.jsonl. It is
 * intentionally not a provider invoice reader: cost-metered rows are
 * local estimates, and subscription rows remain quota/statusline data.
 */

import { readJsonl } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';
import { formatApiCost } from '../analytics/api-cost.js';
import { runtimeBackend } from '../data/mode.js';

const DAY_MS = 86_400_000;

export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const opts = parseArgs(argv, options.now ?? Date.now());
  const history = options.history ?? readJsonl(HISTORY_FILE);
  const report = buildUsageReport(history, opts);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderUsageReport(report));
  }
  return 0;
}

export function buildUsageReport(history, opts = {}) {
  const now = opts.now ?? Date.now();
  const since = opts.since ?? (now - 7 * DAY_MS);
  const until = opts.until ?? now;
  const filtered = (Array.isArray(history) ? history : [])
    .filter(e => inWindow(e, since, until))
    .filter(e => !opts.sessionId || e.session_id === opts.sessionId)
    .filter(e => !opts.projectPath || e.project_path === opts.projectPath);

  const latestBySession = latestSessionRows(filtered);
  const sessions = Array.from(latestBySession.values());
  const costRows = sessions.filter(isApiSpendRow);
  const subscriptionRows = filtered.filter(e => e.billing_signal === 'quota-window');
  const authProviders = countBy(filtered, e => e.auth_provider ?? 'unknown');
  const backends = countBy(filtered, e => e.backend ?? runtimeBackend(e.auth_provider ?? 'unknown', e.billing_signal ?? 'cost-metered'));
  const models = countBy(sessions, e => e.model ?? 'unknown');
  const projects = countBy(sessions, e => e.project_path ?? '(unknown)');
  const vertexRows = sessions.filter(e => e.auth_provider === 'vertex' || e.backend === 'vertex-ai');

  const totals = sessions.reduce((acc, e) => {
    acc.inputTokens += finite(e.input_tokens);
    acc.outputTokens += finite(e.output_tokens);
    acc.cacheCreateTokens += finite(e.cache_create_tokens);
    acc.cacheCreate5mTokens += finite(e.cache_create_5m_tokens);
    acc.cacheCreate1hTokens += finite(e.cache_create_1h_tokens);
    acc.cacheReadTokens += finite(e.cache_read_tokens);
    acc.apiCalls += finite(e.api_calls);
    acc.generationCostUsd += finite(e.generation_cost_usd);
    return acc;
  }, emptyTotals());

  const estimatedApiCostUsd = costRows.reduce((sum, e) => sum + finite(e.session_cost_usd), 0);
  const maturity = computeUsageMaturity(costRows, now);

  return {
    generatedAt: new Date(now).toISOString(),
    window: {
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
    },
    filters: {
      sessionId: opts.sessionId ?? null,
      projectPath: opts.projectPath ?? null,
    },
    source: {
      file: HISTORY_FILE,
      billingSource: 'local-history',
      estimated: true,
      note: 'API spend rows combine statusLine actual costs and local estimates; they are not provider invoices.',
    },
    counts: {
      rows: filtered.length,
      sessions: sessions.length,
      costMeteredSessions: costRows.length,
      subscriptionRows: subscriptionRows.length,
    },
    totals: {
      estimatedApiBillableUsd: estimatedApiCostUsd,
      apiSpendUsd: estimatedApiCostUsd,
      generationReferenceUsd: totals.generationCostUsd,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreateTokens: totals.cacheCreateTokens,
      cacheCreate5mTokens: totals.cacheCreate5mTokens,
      cacheCreate1hTokens: totals.cacheCreate1hTokens,
      cacheReadTokens: totals.cacheReadTokens,
      apiCalls: totals.apiCalls,
    },
    dataMaturity: maturity,
    authProviders,
    backends,
    vertex: summarizeVertex(vertexRows),
    models,
    projects,
    sessions: sessions.map(e => ({
      sessionId: e.session_id ?? null,
      lastSeen: e.ts ?? null,
      projectPath: e.project_path ?? null,
      model: e.model ?? null,
      billingSignal: e.billing_signal ?? null,
      authProvider: e.auth_provider ?? null,
      backend: e.backend ?? runtimeBackend(e.auth_provider ?? 'unknown', e.billing_signal ?? 'cost-metered'),
      telemetryAuthority: e.telemetry_authority ?? null,
      estimatedApiBillableUsd: isApiSpendRow(e) ? finite(e.session_cost_usd) : null,
      apiSpendUsd: isApiSpendRow(e) ? finite(e.session_cost_usd) : null,
      costKind: e.cost_kind ?? null,
      generationReferenceUsd: e.generation_cost_usd ?? null,
      cacheCreateTokens: e.cache_create_tokens ?? null,
      cacheReadTokens: e.cache_read_tokens ?? null,
    })),
  };
}

export function renderUsageReport(report) {
  const lines = [];
  lines.push('claude-ops usage');
  lines.push(`window: ${report.window.since} -> ${report.window.until}`);
  lines.push(`source: ${report.source.file}`);
  lines.push(`sessions: ${report.counts.sessions} (${report.counts.costMeteredSessions} cost-metered), rows: ${report.counts.rows}`);
  lines.push(`API spend actual/estimated: ${formatApiCost(report.totals.apiSpendUsd ?? report.totals.estimatedApiBillableUsd)} (${report.dataMaturity.state})`);
  lines.push(`generation reference: ${formatApiCost(report.totals.generationReferenceUsd)}`);
  lines.push(`tokens: in ${fmtInt(report.totals.inputTokens)} / out ${fmtInt(report.totals.outputTokens)} / cache write ${fmtInt(report.totals.cacheCreateTokens)} / cache read ${fmtInt(report.totals.cacheReadTokens)}`);
  if (Object.keys(report.authProviders).length) lines.push(`providers: ${formatCounts(report.authProviders)}`);
  if (Object.keys(report.backends).length) lines.push(`backends: ${formatCounts(report.backends)}`);
  if (report.vertex.sessions > 0) {
    lines.push(`vertex telemetry: sessions ${report.vertex.sessions}, 5h tokens ${fmtInt(report.vertex.fiveHourTokens)}, quota events ${report.vertex.quotaEvents}, authority ${formatCounts(report.vertex.authorities)}`);
  }
  if (Object.keys(report.models).length) lines.push(`models: ${formatCounts(report.models)}`);
  lines.push(`note: ${report.source.note}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv, now) {
  const opts = { json: false, since: now - 7 * DAY_MS, until: now, now };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--since': opts.since = parseTimeArg(argv[++i], now, opts.since); break;
      case '--until': opts.until = parseTimeArg(argv[++i], now, opts.until); break;
      case '--session': opts.sessionId = argv[++i] ?? null; break;
      case '--project': opts.projectPath = argv[++i] ?? null; break;
      default: break;
    }
  }
  return opts;
}

function parseTimeArg(raw, now, fallback) {
  if (!raw) return fallback;
  const dur = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)$/i);
  if (dur) {
    const n = Number(dur[1]);
    const unit = dur[2].toLowerCase();
    const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : DAY_MS;
    return now - n * mult;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function inWindow(e, since, until) {
  const ts = Date.parse(e.ts);
  return Number.isFinite(ts) && ts >= since && ts <= until;
}

function latestSessionRows(rows) {
  const out = new Map();
  let anonymous = 0;
  for (const row of rows) {
    const key = row.session_id ?? `anonymous-${anonymous++}`;
    const prev = out.get(key);
    if (!prev || Date.parse(row.ts) >= Date.parse(prev.ts)) out.set(key, row);
  }
  return out;
}

function computeUsageMaturity(costRows, now) {
  if (costRows.length === 0) {
    return { state: 'cold_start', reason: 'no API spend rows in window' };
  }
  const sessions = new Set(costRows.map(e => e.session_id).filter(Boolean)).size;
  const oldest = costRows.reduce((min, e) => Math.min(min, Date.parse(e.ts)), Infinity);
  const ageHours = Number.isFinite(oldest) ? (now - oldest) / 3_600_000 : 0;
  if (costRows.length >= 3 && sessions >= 2 && ageHours >= 0.5) {
    return { state: 'local_reference', reason: 'enough local history for a rough reference' };
  }
  return { state: 'warming', reason: `${costRows.length} cost rows across ${sessions} sessions` };
}

function isApiSpendRow(e) {
  return e?.cost_kind === 'api_billable_estimate' || e?.cost_kind === 'api_statusline_actual';
}

function countBy(rows, fn) {
  const out = {};
  for (const row of rows) {
    const key = fn(row);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheCreate5mTokens: 0,
    cacheCreate1hTokens: 0,
    cacheReadTokens: 0,
    apiCalls: 0,
    generationCostUsd: 0,
  };
}

function summarizeVertex(rows) {
  return rows.reduce((acc, e) => {
    acc.sessions += 1;
    acc.fiveHourTokens += finite(e.vertex_5h_tokens);
    acc.sevenDayTokens += finite(e.vertex_7d_tokens);
    const authority = e.vertex_telemetry_authority ?? e.telemetry_authority ?? 'unknown';
    acc.authorities[authority] = (acc.authorities[authority] ?? 0) + 1;
    if (e.quota_event_reason === 'GCP_QUOTA_EXHAUSTED') acc.quotaEvents += 1;
    return acc;
  }, { sessions: 0, fiveHourTokens: 0, sevenDayTokens: 0, quotaEvents: 0, authorities: {} });
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : 0;
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function formatCounts(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
}

function printHelp() {
  process.stdout.write(`\
claude-ops usage [--json] [--since <date|duration>] [--until <date|duration>] [--session ID] [--project PATH]

Summarize local Claude Ops usage-history rows. Durations accept m/h/d
suffixes, for example --since 24h or --since 7d.
`);
}

if (process.argv[1] && process.argv[1].endsWith('/usage.js')) {
  main().then(code => process.exit(code ?? 0));
}
