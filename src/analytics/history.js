/**
 * Usage history writer — appends to usage-history.jsonl every 5 minutes.
 */
import { appendJsonl } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';

/**
 * Write a history entry. Callers pass a sessionId so rate-projection
 * readers can filter to a single session's burn trajectory; account-
 * global rate-limit fields (fiveHourPct/sevenDayPct) stay account-global.
 * @param {object} params
 * @param {string|null} [params.sessionId]
 * @param {number|null} params.fiveHourPct
 * @param {number|null} params.sevenDayPct
 * @param {number} params.sessionBurnRate
 * @param {number} params.contextPct
 * @param {string} params.signal
 * @param {string} params.model
 * @param {string} params.effort
 * @param {number|null} [params.rtkSaved]
 * @param {number|null} [params.rtkSavingsPct]
 * @param {number|null} [params.sessionCostUsd]   - API billable-estimate USD cost for this session
 * @param {number|null} [params.generationCostUsd] - generation-only reference USD cost
 * @param {'api_billable_estimate'|'api_statusline_actual'|'generation_reference'|null} [params.costKind]
 * @param {'max'|'api'|'bedrock'|'daemon'|'unknown'} [params.mode] - session mode at write time
 * @param {'quota-window'|'cost-metered'|null} [params.billingSignal]
 * @param {string|null} [params.authProvider]
 * @param {string|null} [params.backend]
 * @param {string|null} [params.telemetryAuthority]
 * @param {string|null} [params.projectPath]
 * @param {number|null} [params.contextTokens]
 * @param {number|null} [params.contextInputTokens]
 * @param {number|null} [params.contextOutputTokens]
 * @param {number|null} [params.contextThinkingTokens]
 * @param {boolean|null} [params.exceeds200k]
 * @param {number|null} [params.inputTokens]
 * @param {number|null} [params.outputTokens]
 * @param {number|null} [params.cacheCreateTokens]
 * @param {number|null} [params.cacheCreate5mTokens]
 * @param {number|null} [params.cacheCreate1hTokens]
 * @param {number|null} [params.cacheReadTokens]
 * @param {number|null} [params.apiCalls]
 * @param {object|null} [params.vertexTelemetry]
 */
export function writeHistoryEntry({
  sessionId,
  fiveHourPct,
  sevenDayPct,
  sessionBurnRate,
  contextPct,
  signal,
  model,
  effort,
  rtkSaved,
  rtkSavingsPct,
  sessionCostUsd,
  generationCostUsd,
  costKind,
  mode,
  billingSignal,
  authProvider,
  backend,
  telemetryAuthority,
  projectPath,
  contextTokens,
  contextInputTokens,
  contextOutputTokens,
  contextThinkingTokens,
  exceeds200k,
  inputTokens,
  outputTokens,
  cacheCreateTokens,
  cacheCreate5mTokens,
  cacheCreate1hTokens,
  cacheReadTokens,
  apiCalls,
  vertexTelemetry,
}) {
  const entry = {
    schema_version: 4,
    ts: new Date().toISOString(),
    session_id: sessionId ?? null,
    five_hour_pct: fiveHourPct ?? null,
    seven_day_pct: sevenDayPct ?? null,
    session_burn_rate: sessionBurnRate,
    context_pct: contextPct,
    signal,
    model,
    effort,
    mode: mode ?? null,
    billing_signal: billingSignal ?? null,
    auth_provider: authProvider ?? null,
    backend: backend ?? null,
    telemetry_authority: telemetryAuthority ?? null,
    project_path: projectPath ?? null,
  };
  if (rtkSaved != null) entry.rtk_saved = rtkSaved;
  if (rtkSavingsPct != null) entry.rtk_savings_pct = rtkSavingsPct;
  if (sessionCostUsd != null && Number.isFinite(sessionCostUsd) && sessionCostUsd > 0) {
    entry.session_cost_usd = sessionCostUsd;
    entry.cost_kind = costKind ?? 'api_billable_estimate';
  }
  if (generationCostUsd != null && Number.isFinite(generationCostUsd) && generationCostUsd > 0) {
    entry.generation_cost_usd = generationCostUsd;
  }
  addFinite(entry, 'context_tokens', contextTokens);
  addFinite(entry, 'context_input_tokens', contextInputTokens);
  addFinite(entry, 'context_output_tokens', contextOutputTokens);
  addFinite(entry, 'context_thinking_tokens', contextThinkingTokens);
  if (typeof exceeds200k === 'boolean') entry.exceeds_200k_tokens = exceeds200k;
  addFinite(entry, 'input_tokens', inputTokens);
  addFinite(entry, 'output_tokens', outputTokens);
  addFinite(entry, 'cache_create_tokens', cacheCreateTokens);
  addFinite(entry, 'cache_create_5m_tokens', cacheCreate5mTokens);
  addFinite(entry, 'cache_create_1h_tokens', cacheCreate1hTokens);
  addFinite(entry, 'cache_read_tokens', cacheReadTokens);
  addFinite(entry, 'api_calls', apiCalls);
  if (vertexTelemetry) {
    entry.vertex_telemetry_authority = vertexTelemetry.telemetryAuthority ?? null;
    entry.vertex_maturity = vertexTelemetry.dataMaturity?.state ?? null;
    entry.vertex_confidence_cap = vertexTelemetry.confidenceCap ?? null;
    if (vertexTelemetry.synthetic) {
      entry.synthetic_telemetry = 'vertex-local';
    }
    if (vertexTelemetry.missingApiTelemetry) {
      entry.vertex_api_telemetry_missing = true;
      entry.vertex_api_telemetry_reason = vertexTelemetry.apiTelemetryReason ?? null;
    }
    addFinite(entry, 'vertex_5h_tokens', vertexTelemetry.fiveHour?.totalTokens);
    addFinite(entry, 'vertex_7d_tokens', vertexTelemetry.sevenDay?.totalTokens);
    if (vertexTelemetry.latestQuotaEvent) {
      entry.quota_event_reason = vertexTelemetry.latestQuotaEvent.causalReason ?? 'GCP_QUOTA_EXHAUSTED';
      entry.quota_event_code = vertexTelemetry.latestQuotaEvent.code ?? null;
      entry.quota_event_ts = vertexTelemetry.latestQuotaEvent.ts ?? null;
    }
  }
  appendJsonl(HISTORY_FILE, entry);
}

function addFinite(entry, key, value) {
  if (value != null && Number.isFinite(value) && value >= 0) entry[key] = value;
}
