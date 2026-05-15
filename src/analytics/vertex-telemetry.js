/**
 * Vertex AI telemetry.
 *
 * Preferred source is an authoritative API snapshot (for example from Cloud
 * Monitoring/Billing collectors). If unavailable, Claude Ops can fall back to
 * local synthetic rolling windows built from usage history and transcript
 * evidence.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readJsonlWindow } from '../data/jsonl.js';
import { HISTORY_FILE, VERTEX_API_TELEMETRY_FILE, VERTEX_QUOTA_EVENTS_FILE } from '../data/paths.js';
import { getTelemetryTuning } from '../data/defaults.js';

export const FIVE_HOUR_MS = 5 * 3600 * 1000;
export const SEVEN_DAY_MS = 7 * 86400 * 1000;
const QUOTA_EVENT_ACTIVE_MS = FIVE_HOUR_MS;

/**
 * Compute Vertex telemetry for HUD/advisor.
 *
 * Priority:
 *  1) API snapshot file (telemetryAuthority=vertex-api)
 *  2) Local synthetic fallback
 *
 * By default, Vertex requires API telemetry. Fallback still renders, but it is
 * tagged as missingApiTelemetry so advisory logic can fail closed.
 */
export function computeVertexTelemetry(tokenStats, history, options = {}) {
  const now = options.now ?? Date.now();
  const vertexContext = options.vertexContext ?? buildVertexTelemetryContext(options.env ?? process.env);
  const apiFile = options.vertexApiFile
    ?? options.env?.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE
    ?? process.env.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE
    ?? VERTEX_API_TELEMETRY_FILE;

  const apiTelemetry = readVertexApiTelemetry(apiFile, { now, vertexContext });
  const staleReason = apiTelemetry ? staleVertexApiSnapshotReason(apiTelemetry, now, options) : null;
  if (apiTelemetry && !staleReason) return apiTelemetry;

  const synthetic = computeVertexSyntheticTelemetry(tokenStats, history, options);
  if (!resolveRequireApi(options)) return synthetic;

  return {
    ...synthetic,
    missingApiTelemetry: true,
    apiTelemetryFile: apiFile,
    apiTelemetryReason: staleReason
      ? `authoritative Vertex API snapshot stale: ${basename(apiFile)} (${staleReason})`
      : `authoritative Vertex API snapshot missing or invalid: ${basename(apiFile)}`,
  };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {object|null} [stdin]
 */
export function buildVertexTelemetryContext(env = process.env, stdin = null) {
  const region = firstNonEmpty(
    env.CLOUD_ML_REGION,
    ...Object.keys(env).filter(k => k.startsWith('VERTEX_REGION_CLAUDE_')).sort().map(k => env[k]),
  );
  return {
    projectId: firstNonEmpty(env.ANTHROPIC_VERTEX_PROJECT_ID, env.GOOGLE_CLOUD_PROJECT, env.GCLOUD_PROJECT),
    region,
    model: firstNonEmpty(
      stdin?.model?.id,
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    ),
    endpoint: firstNonEmpty(env.ANTHROPIC_VERTEX_BASE_URL),
  };
}

/**
 * Vertex AI synthetic telemetry.
 *
 * Vertex does not expose Anthropic-style rate-limit headers to Claude Ops, so
 * this module builds local rolling token windows from usage history and current
 * statusline/transcript counters. It never reports provider-side remaining
 * quota or reset times.
 */

/**
 * @typedef {object} VertexSyntheticTelemetry
 * @property {'vertex-ai'} backend
 * @property {'local-synthetic'} telemetryAuthority
 * @property {true} synthetic
 * @property {true} estimated
 * @property {{ state:'cold_start'|'warming'|'local_reference', reason:string, samples:number, distinctSessions:number }} dataMaturity
 * @property {'low'|'med'} confidenceCap
 * @property {object|null} latestQuotaEvent
 * @property {'limit_hit'|null} signal
 * @property {'GCP_QUOTA_EXHAUSTED'|null} causalReason
 * @property {object} fiveHour
 * @property {object} sevenDay
 */

/**
 * Compute local Vertex rolling-window counters.
 *
 * @param {object|null} tokenStats
 * @param {object[]|undefined} history
 * @param {{ currentSessionId?: string|null, now?: number, quotaEvents?: object[], quotaEventFile?: string }} [options]
 * @returns {VertexSyntheticTelemetry}
 */
export function computeVertexSyntheticTelemetry(tokenStats, history, options = {}) {
  const now = options.now ?? Date.now();
  const hist = history ?? safeReadHistory();
  const vertexRows = hist.filter(isVertexHistoryRow);
  const currentRow = currentTokenRow(tokenStats, options.currentSessionId, now);
  const rows = currentRow ? [...vertexRows.filter(e => e.session_id !== currentRow.session_id), currentRow] : vertexRows;

  const fiveHour = aggregateWindow(rows, now - FIVE_HOUR_MS);
  const sevenDay = aggregateWindow(rows, now - SEVEN_DAY_MS);
  const maturity = computeMaturity(vertexRows, now);
  const latestQuotaEvent = latestActiveQuotaEvent([
    ...quotaEventsFromHistory(vertexRows),
    ...normalizeQuotaEvents(options.quotaEvents ?? []),
    ...readQuotaEventFile(options.quotaEventFile ?? process.env.CLAUDE_OPS_VERTEX_QUOTA_EVENT_FILE ?? VERTEX_QUOTA_EVENTS_FILE),
  ], now);

  const confidenceCap = latestQuotaEvent || maturity.state === 'local_reference' ? 'med' : 'low';

  return {
    backend: 'vertex-ai',
    telemetryAuthority: 'local-synthetic',
    synthetic: true,
    estimated: true,
    missingApiTelemetry: false,
    dataMaturity: maturity,
    confidenceCap,
    latestQuotaEvent,
    signal: latestQuotaEvent ? 'limit_hit' : null,
    causalReason: latestQuotaEvent ? 'GCP_QUOTA_EXHAUSTED' : null,
    fiveHour,
    sevenDay,
  };
}

/**
 * Extract a quota event from raw transcript/status/error text.
 *
 * @param {string} text
 * @param {{ timestamp?: string|Date|null, source?: string }} [meta]
 * @returns {object[]}
 */
export function extractVertexQuotaEventsFromText(text, meta = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const resourceExhausted = /RESOURCE_EXHAUSTED/i.test(text);
  const quotaLanguage = /\bquota\b|\brate.?limit\b|\bexhaust/i.test(text);
  const http429 = /(?:\bstatus\b|\bcode\b|HTTP)?\s*[:=]?\s*429\b/i.test(text);
  if (!resourceExhausted && !(http429 && quotaLanguage)) return [];
  return [{
    ts: normalizeTimestamp(meta.timestamp) ?? new Date().toISOString(),
    backend: 'vertex-ai',
    status: http429 ? 429 : null,
    code: resourceExhausted ? 'RESOURCE_EXHAUSTED' : 'HTTP_429',
    causalReason: 'GCP_QUOTA_EXHAUSTED',
    source: meta.source ?? 'local-evidence',
  }];
}

function resolveRequireApi(options) {
  if (typeof options.requireApi === 'boolean') return options.requireApi;
  const env = options.env?.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY
    ?? process.env.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY;
  if (env == null || env === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(env).trim().toLowerCase());
}

function readVertexApiTelemetry(path, { now = Date.now(), vertexContext = null } = {}) {
  if (!path) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return normalizeApiSnapshot(raw, path, now, vertexContext);
}

function normalizeApiSnapshot(raw, path, now, vertexContext = null) {
  if (!raw || typeof raw !== 'object') return null;

  const hasFiveHourWindow = hasApiWindowKey(raw, ['fiveHour', 'five_hour', 'window5h', 'window_5h']);
  const hasSevenDayWindow = hasApiWindowKey(raw, ['sevenDay', 'seven_day', 'window7d', 'window_7d']);

  const fiveHour = normalizeApiWindow(raw.fiveHour ?? raw.five_hour ?? raw.window5h ?? raw.window_5h);
  const sevenDay = normalizeApiWindow(raw.sevenDay ?? raw.seven_day ?? raw.window7d ?? raw.window_7d);

  // Fail closed when a declared window payload is malformed. This prevents
  // partially valid authoritative snapshots from masking broken fields.
  if ((hasFiveHourWindow && !fiveHour) || (hasSevenDayWindow && !sevenDay)) return null;
  if (!fiveHour && !sevenDay) return null;

  const latestQuotaEvent = latestActiveQuotaEvent(
    [raw.latestQuotaEvent ?? raw.latest_quota_event ?? raw.quotaEvent ?? raw.quota_event].filter(Boolean),
    now,
  );

  const retrievedAt = normalizeTimestamp(raw.retrievedAt ?? raw.retrieved_at ?? raw.generatedAt ?? raw.generated_at);
  if (!retrievedAt) return null;
  const metadata = normalizeSnapshotMetadata(raw);
  if (!snapshotMatchesContext(metadata, vertexContext)) return null;
  const declaredWindows = [
    hasFiveHourWindow ? fiveHour : null,
    hasSevenDayWindow ? sevenDay : null,
  ].filter(Boolean);
  const hasAnyWindowCost = declaredWindows.some(win => win.costBacked);
  const allDeclaredWindowsCostBacked = declaredWindows.length > 0
    && declaredWindows.every(win => win.costBacked);
  const hasCostSource = nonEmpty(metadata.costSource) || hasAnyWindowCost;
  if (!metadata.costSource && hasCostSource) metadata.costSource = 'snapshot-cost-field';
  const costBacked = Boolean(allDeclaredWindowsCostBacked && hasCostSource);
  const tokenMetricsOnly = !costBacked;

  const mature = {
    state: costBacked ? 'authoritative' : 'metrics_reference',
    reason: `${costBacked ? 'authoritative Vertex API snapshot' : 'Vertex token metrics snapshot'} (${basename(path)})`,
    samples: Number.isFinite(raw.samples) ? Number(raw.samples) : 1,
    distinctSessions: Number.isFinite(raw.distinctSessions) ? Number(raw.distinctSessions) : 1,
  };

  return {
    backend: 'vertex-ai',
    telemetryAuthority: costBacked ? 'vertex-api' : 'vertex-metrics-estimate',
    synthetic: false,
    estimated: tokenMetricsOnly,
    authoritative: costBacked,
    missingApiTelemetry: false,
    retrievedAt,
    metadata,
    dataMaturity: mature,
    confidenceCap: costBacked ? 'high' : 'med',
    latestQuotaEvent,
    signal: latestQuotaEvent ? 'limit_hit' : null,
    causalReason: latestQuotaEvent ? 'GCP_QUOTA_EXHAUSTED' : null,
    fiveHour: fiveHour ?? emptyTotalsWithCounts(),
    sevenDay: sevenDay ?? emptyTotalsWithCounts(),
  };
}

function hasApiWindowKey(raw, keys) {
  if (!raw || typeof raw !== 'object') return false;
  return keys.some(key => Object.prototype.hasOwnProperty.call(raw, key));
}

function staleVertexApiSnapshotReason(apiTelemetry, now, options = {}) {
  const maxAgeMinutes = resolveVertexApiSnapshotMaxAgeMinutes(options);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) return null;
  const retrievedMs = Date.parse(apiTelemetry?.retrievedAt ?? '');
  if (!Number.isFinite(retrievedMs)) return 'missing retrieved_at timestamp';
  const ageMinutes = (now - retrievedMs) / 60_000;
  if (!Number.isFinite(ageMinutes)) return 'invalid retrieved_at timestamp';
  if (ageMinutes <= maxAgeMinutes) return null;
  return `${ageMinutes.toFixed(1)}m old > ${maxAgeMinutes.toFixed(1)}m max`;
}

function resolveVertexApiSnapshotMaxAgeMinutes(options = {}) {
  if (Number.isFinite(options.vertexApiMaxSnapshotAgeMinutes)) {
    return Number(options.vertexApiMaxSnapshotAgeMinutes);
  }
  const env = options.env?.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES
    ?? process.env.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES;
  if (env != null && env !== '') {
    const parsed = Number(env);
    if (Number.isFinite(parsed)) return parsed;
  }
  return getTelemetryTuning().vertexApi.maxSnapshotAgeMinutes;
}
function normalizeApiWindow(win) {
  if (!win || typeof win !== 'object') return null;

  const hasNumericInput = [
    win.totalTokens, win.total_tokens, win.tokens,
    win.inputTokens, win.input_tokens,
    win.outputTokens, win.output_tokens,
    win.cacheCreateTokens, win.cache_create_tokens,
    win.cacheReadTokens, win.cache_read_tokens,
    win.apiCalls, win.api_calls, win.requestCount, win.request_count,
    win.burnRate, win.burn_rate,
    win.sessions, win.distinctSessions, win.distinct_sessions,
    win.samples, win.points,
    win.costUsd, win.cost_usd, win.billableCostUsd, win.billable_cost_usd, win.estimatedCostUsd, win.estimated_cost_usd,
  ].some(v => toFiniteNumber(v) != null);
  if (!hasNumericInput) return null;

  const hasTotalTokenField = hasApiWindowKey(win, ['totalTokens', 'total_tokens', 'tokens']);
  const totalTokenRaw = win.totalTokens ?? win.total_tokens ?? win.tokens;
  if (hasTotalTokenField && toFiniteNumber(totalTokenRaw) == null) return null;

  const hasCostField = hasApiWindowKey(win, ['costUsd', 'cost_usd', 'billableCostUsd', 'billable_cost_usd', 'estimatedCostUsd', 'estimated_cost_usd']);
  const costRaw = win.costUsd
    ?? win.cost_usd
    ?? win.billableCostUsd
    ?? win.billable_cost_usd
    ?? win.estimatedCostUsd
    ?? win.estimated_cost_usd;
  if (hasCostField && toFiniteNumber(costRaw) == null) return null;

  const inputTokens = finite(win.inputTokens ?? win.input_tokens);
  const outputTokens = finite(win.outputTokens ?? win.output_tokens);
  const cacheCreateTokens = finite(win.cacheCreateTokens ?? win.cache_create_tokens);
  const cacheReadTokens = finite(win.cacheReadTokens ?? win.cache_read_tokens);
  const apiCalls = finite(win.apiCalls ?? win.api_calls ?? win.requestCount ?? win.request_count);
  const burnRate = finite(win.burnRate ?? win.burn_rate);
  const sessions = finite(win.sessions ?? win.distinctSessions ?? win.distinct_sessions);
  const samples = finite(win.samples ?? win.points);
  const totalTokens = finite(totalTokenRaw)
    || (inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens);
  const costUsd = hasCostField ? finite(costRaw) : null;
  const invalidNegativeCounter = [
    sessions,
    samples,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    apiCalls,
    burnRate,
    totalTokens,
  ].some(v => v < 0);
  if (invalidNegativeCounter) return null;

  return {
    sessions,
    samples,
    inputTokens,
    outputTokens,
    cacheCreateTokens,
    cacheReadTokens,
    apiCalls,
    burnRate,
    totalTokens,
    costUsd,
    costBacked: costUsd != null,
  };
}

function normalizeSnapshotMetadata(raw) {
  const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  return {
    projectId: firstNonEmpty(raw.projectId, raw.project_id, meta.projectId, meta.project_id),
    region: firstNonEmpty(raw.region, raw.location, raw.location_id, meta.region, meta.location),
    model: firstNonEmpty(raw.model, raw.modelId, raw.model_id, meta.model, meta.modelId, meta.model_id),
    endpoint: firstNonEmpty(raw.endpoint, raw.baseUrl, raw.base_url, meta.endpoint, meta.baseUrl, meta.base_url),
    source: firstNonEmpty(raw.source, raw.metricSource, raw.metric_source, meta.source, meta.metricSource, meta.metric_source),
    costSource: firstNonEmpty(raw.costSource, raw.cost_source, raw.billingSource, raw.billing_source, meta.costSource, meta.cost_source, meta.billingSource, meta.billing_source),
    currency: firstNonEmpty(raw.currency, meta.currency) ?? 'USD',
  };
}

function snapshotMatchesContext(metadata, context) {
  if (!context || typeof context !== 'object') return true;
  return matchesField(metadata.projectId, context.projectId)
    && matchesField(metadata.region, context.region)
    && matchesModel(metadata.model, context.model)
    && matchesField(metadata.endpoint, context.endpoint);
}

function matchesField(snapshotValue, contextValue) {
  if (!nonEmpty(contextValue)) return true;
  if (!nonEmpty(snapshotValue)) return true;
  return String(snapshotValue).trim().toLowerCase() === String(contextValue).trim().toLowerCase();
}

function matchesModel(snapshotValue, contextValue) {
  if (!nonEmpty(contextValue)) return true;
  if (!nonEmpty(snapshotValue)) return true;
  const snap = normalizeModelId(snapshotValue);
  const ctx = normalizeModelId(contextValue);
  return snap === ctx || snap.includes(ctx) || ctx.includes(snap);
}

function normalizeModelId(value) {
  return String(value).trim().toLowerCase().replace(/^publishers\/anthropic\/models\//, '');
}

function aggregateWindow(rows, cutoffMs) {
  const latestBySession = latestRowsBySession(rows.filter(e => Date.parse(e.ts) >= cutoffMs));
  const values = Array.from(latestBySession.values());
  const totals = values.reduce((acc, e) => {
    acc.inputTokens += finite(e.input_tokens);
    acc.outputTokens += finite(e.output_tokens);
    acc.cacheCreateTokens += finite(e.cache_create_tokens);
    acc.cacheReadTokens += finite(e.cache_read_tokens);
    acc.apiCalls += finite(e.api_calls);
    acc.burnRate += finite(e.session_burn_rate);
    return acc;
  }, emptyTotals());
  totals.totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheCreateTokens + totals.cacheReadTokens;
  return {
    sessions: latestBySession.size,
    samples: values.length,
    ...totals,
  };
}

function currentTokenRow(tokenStats, currentSessionId, now) {
  if (!tokenStats) return null;
  return {
    ts: new Date(now).toISOString(),
    session_id: currentSessionId ?? '__current_vertex_session__',
    auth_provider: 'vertex',
    backend: 'vertex-ai',
    telemetry_authority: 'local-synthetic',
    input_tokens: finite(tokenStats.totalInput),
    output_tokens: finite(tokenStats.totalOutput),
    cache_create_tokens: finite(tokenStats.totalCacheCreate),
    cache_read_tokens: finite(tokenStats.totalCacheRead),
    api_calls: finite(tokenStats.apiCalls),
    session_burn_rate: finite(tokenStats.burnRate),
  };
}

function latestRowsBySession(rows) {
  const out = new Map();
  let anonymous = 0;
  for (const row of rows) {
    const key = row.session_id ?? `anonymous-${anonymous++}`;
    const prev = out.get(key);
    if (!prev || Date.parse(row.ts) >= Date.parse(prev.ts)) out.set(key, row);
  }
  return out;
}

function computeMaturity(rows, now) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { state: 'cold_start', reason: 'no local Vertex history yet', samples: 0, distinctSessions: 0 };
  }
  const tuning = getTelemetryTuning().vertexSynthetic;
  const samples = rows.length;
  const distinctSessions = new Set(rows.map(e => e.session_id).filter(Boolean)).size;
  const oldestTs = rows.reduce((min, e) => Math.min(min, Date.parse(e.ts)), Infinity);
  const oldestAgeMinutes = Number.isFinite(oldestTs) ? (now - oldestTs) / 60_000 : 0;
  if (
    samples >= tuning.minSamples
    && distinctSessions >= tuning.minDistinctSessions
    && oldestAgeMinutes >= tuning.minOldestAgeMinutes
  ) {
    return {
      state: 'local_reference',
      reason: 'local Vertex token history is mature enough for comparison',
      samples,
      distinctSessions,
    };
  }
  return {
    state: 'warming',
    reason: `warming local Vertex telemetry (${samples}/${tuning.minSamples} samples, ${distinctSessions}/${tuning.minDistinctSessions} sessions, ${Math.floor(oldestAgeMinutes)}/${tuning.minOldestAgeMinutes} min span)`,
    samples,
    distinctSessions,
  };
}

function latestActiveQuotaEvent(events, now) {
  const latest = normalizeQuotaEvents(events)
    .filter(e => now - Date.parse(e.ts) <= QUOTA_EVENT_ACTIVE_MS)
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  return latest ?? null;
}

function readQuotaEventFile(path) {
  if (!path) return [];
  try { return normalizeQuotaEvents(readJsonlWindow(path, SEVEN_DAY_MS)); }
  catch { return []; }
}

function quotaEventsFromHistory(rows) {
  return rows
    .filter(e => e.quota_event_reason === 'GCP_QUOTA_EXHAUSTED' || e.quota_event_code === 'RESOURCE_EXHAUSTED')
    .map(e => ({
      ts: e.quota_event_ts ?? e.ts,
      code: e.quota_event_code ?? 'RESOURCE_EXHAUSTED',
      status: 429,
      causalReason: 'GCP_QUOTA_EXHAUSTED',
      source: 'usage-history',
    }));
}

function normalizeQuotaEvents(events) {
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const code = String(event.code ?? event.status ?? event.error_code ?? '').toUpperCase();
    const text = String(event.message ?? event.error ?? event.reason ?? event.causalReason ?? '');
    const resourceExhausted = code.includes('RESOURCE_EXHAUSTED') || /RESOURCE_EXHAUSTED/i.test(text);
    const http429 = Number(event.status) === 429 || code === '429' || /\b429\b/.test(text);
    const quotaLanguage = /\bquota\b|\brate.?limit\b|\bexhaust/i.test(text);
    if (!resourceExhausted && !(http429 && quotaLanguage)) continue;
    const ts = normalizeTimestamp(event.ts ?? event.timestamp ?? event.time ?? event.at);
    if (!ts) continue;
    out.push({
      ts,
      backend: 'vertex-ai',
      status: http429 ? 429 : (Number.isFinite(Number(event.status)) ? Number(event.status) : null),
      code: resourceExhausted ? 'RESOURCE_EXHAUSTED' : 'HTTP_429',
      causalReason: 'GCP_QUOTA_EXHAUSTED',
      source: event.source ?? 'local-event',
    });
  }
  return out;
}

function isVertexHistoryRow(row) {
  return row?.auth_provider === 'vertex'
    || row?.backend === 'vertex-ai';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return String(value).trim();
  }
  return null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  return null;
}

function safeReadHistory() {
  try { return readJsonlWindow(HISTORY_FILE, SEVEN_DAY_MS); }
  catch { return []; }
}

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    apiCalls: 0,
    burnRate: 0,
    totalTokens: 0,
  };
}

function emptyTotalsWithCounts() {
  return {
    sessions: 0,
    samples: 0,
    ...emptyTotals(),
  };
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value);
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finite(value) {
  const parsed = toFiniteNumber(value);
  return parsed == null ? 0 : parsed;
}
