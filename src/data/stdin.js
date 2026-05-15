/**
 * @typedef {object} StdinData
 * @property {string} [session_id]
 * @property {string} [session_name]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 * @property {{ current_dir?: string, project_dir?: string, added_dirs?: string[], git_worktree?: string }} [workspace]
 * @property {{ id?: string, display_name?: string }} [model]
 * @property {{ total_cost_usd?: number, total_duration_ms?: number, total_api_duration_ms?: number, total_lines_added?: number, total_lines_removed?: number }} [cost]
 * @property {{ level?: string }} [effort]
 * @property {boolean} [exceeds_200k_tokens]
 * @property {{ context_window_size?: number, used_percentage?: number|null, usage_ratio?: number|null, remaining_percentage?: number|null, total_tokens?: number, total_input_tokens?: number, total_output_tokens?: number, total_thinking_tokens?: number, exceeds_200k_tokens?: boolean, current_usage?: { input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number }|null }} [context_window]
 * @property {{ five_hour?: { used_percentage?: number|null, resets_at?: number|null }|null, seven_day?: { used_percentage?: number|null, resets_at?: number|null }|null }|null} [rate_limits]
 * @property {{ name?: string }} [agent]
 * @property {{ name?: string, path?: string, branch?: string, original_cwd?: string, original_branch?: string }} [worktree]
 */

/**
 * Extract the session id from a stdin payload. Prefers the explicit
 * `session_id` field that Claude Code passes; falls back to parsing
 * the basename of `transcript_path` (sessions are stored as
 * `<sessionId>.jsonl`).
 * @param {StdinData|null|undefined} stdin
 * @returns {string|null}
 */
export function getSessionId(stdin) {
  if (!stdin) return null;
  if (typeof stdin.session_id === 'string' && stdin.session_id.length > 0) {
    return stdin.session_id;
  }
  const tp = stdin.transcript_path;
  if (typeof tp === 'string' && tp.length > 0) {
    const match = tp.match(/([0-9a-f-]{8,})\.jsonl$/i);
    if (match) return match[1];
  }
  return null;
}

/**
 * @typedef {object} UsageData
 * @property {number|null} fiveHour
 * @property {number|null} sevenDay
 * @property {Date|null} fiveHourResetAt
 * @property {Date|null} sevenDayResetAt
 */

const AUTOCOMPACT_BUFFER_PERCENT = 0.165;

/**
 * Read all of stdin as a single JSON blob. One-shot: collects, parses, returns.
 * @returns {Promise<StdinData|null>}
 */
export async function readStdin() {
  if (process.stdin.isTTY) return null;

  const chunks = [];
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = chunks.join('');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Normalize the current Claude Code statusLine context-window counters.
 *
 * `current_usage` is the current context-window mix, not cumulative billing.
 * Prefer native total fields when present and only fall back to the older
 * current_usage sum for legacy fixtures.
 *
 * @param {StdinData|null|undefined} stdin
 * @returns {{ totalTokens:number, inputTokens:number, outputTokens:number, thinkingTokens:number, cacheCreateTokens:number, cacheReadTokens:number, contextWindowSize:number|null, exceeds200k:boolean }}
 */
export function getContextUsage(stdin) {
  const cw = stdin?.context_window ?? {};
  const usage = cw.current_usage ?? {};
  const inputTokens = finite(cw.total_input_tokens) ?? finite(usage.input_tokens) ?? 0;
  const outputTokens = finite(cw.total_output_tokens) ?? finite(usage.output_tokens) ?? 0;
  const thinkingTokens = finite(cw.total_thinking_tokens) ?? 0;
  const cacheCreateTokens = finite(usage.cache_creation_input_tokens) ?? 0;
  const cacheReadTokens = finite(usage.cache_read_input_tokens) ?? 0;
  const nativeTotal = finite(cw.total_tokens);
  const legacyTotal = inputTokens + outputTokens + thinkingTokens + cacheCreateTokens + cacheReadTokens;

  return {
    totalTokens: nativeTotal ?? legacyTotal,
    inputTokens,
    outputTokens,
    thinkingTokens,
    cacheCreateTokens,
    cacheReadTokens,
    contextWindowSize: finite(cw.context_window_size),
    exceeds200k: Boolean(cw.exceeds_200k_tokens ?? stdin?.exceeds_200k_tokens),
  };
}

/**
 * @param {StdinData|null|undefined} stdin
 * @returns {{ costUsd:number|null, authority:'statusline-cost'|'missing' }}
 */
export function getStatusLineCost(stdin) {
  const cost = finite(stdin?.cost?.total_cost_usd);
  return { costUsd: cost, authority: cost == null ? 'missing' : 'statusline-cost' };
}

/**
 * @param {StdinData|null|undefined} stdin
 * @returns {string|null}
 */
export function getStatusLineEffort(stdin) {
  const level = stdin?.effort?.level;
  return typeof level === 'string' && level.trim() ? level.trim().toLowerCase() : null;
}

/**
 * @param {StdinData} stdin
 * @returns {number}
 */
export function getTotalTokens(stdin) {
  return getContextUsage(stdin).totalTokens;
}

/**
 * @param {StdinData} stdin
 * @returns {number|null}
 */
function getNativePercent(stdin) {
  const nativePercent = stdin.context_window?.used_percentage;
  if (typeof nativePercent === 'number' && !Number.isNaN(nativePercent)) {
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
  }
  const ratio = stdin.context_window?.usage_ratio;
  if (typeof ratio === 'number' && Number.isFinite(ratio)) {
    const pct = ratio <= 1 ? ratio * 100 : ratio;
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
  return null;
}

/**
 * @param {StdinData} stdin
 * @returns {number}
 */
export function getContextPercent(stdin) {
  const native = getNativePercent(stdin);
  if (native !== null) return native;

  const size = getContextUsage(stdin).contextWindowSize;
  if (!size || size <= 0) return 0;

  const totalTokens = getTotalTokens(stdin);
  return Math.min(100, Math.round((totalTokens / size) * 100));
}

/**
 * @param {StdinData} stdin
 * @returns {number}
 */
export function getBufferedPercent(stdin) {
  const native = getNativePercent(stdin);
  if (native !== null) return native;

  const size = getContextUsage(stdin).contextWindowSize;
  if (!size || size <= 0) return 0;

  const totalTokens = getTotalTokens(stdin);
  const rawRatio = totalTokens / size;
  const LOW = 0.05;
  const HIGH = 0.50;
  const scale = Math.min(1, Math.max(0, (rawRatio - LOW) / (HIGH - LOW)));
  const buffer = size * AUTOCOMPACT_BUFFER_PERCENT * scale;

  return Math.min(100, Math.round(((totalTokens + buffer) / size) * 100));
}

/**
 * @param {StdinData} stdin
 * @returns {string}
 */
export function getModelName(stdin) {
  const displayName = stdin.model?.display_name?.trim();
  if (displayName) return displayName;

  const modelId = stdin.model?.id?.trim();
  if (!modelId) return 'Unknown';

  return normalizeBedrockModelLabel(modelId) ?? modelId;
}

/**
 * @param {string} [modelId]
 * @returns {boolean}
 */
export function isBedrockModelId(modelId) {
  if (!modelId) return false;
  return modelId.toLowerCase().includes('anthropic.claude-');
}

/**
 * @param {StdinData} stdin
 * @returns {string|null}
 */
export function getProviderLabel(stdin) {
  if (isBedrockModelId(stdin.model?.id)) return 'Bedrock';
  return null;
}

/**
 * @param {number|null|undefined} value
 * @returns {number|null}
 */
function parseRateLimitPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/**
 * @param {number|null|undefined} value
 * @returns {Date|null}
 */
function parseRateLimitResetAt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

/**
 * @param {StdinData} stdin
 * @returns {UsageData|null}
 */
export function getUsageFromStdin(stdin) {
  const rateLimits = stdin.rate_limits;
  if (!rateLimits) return null;

  const fiveHour = parseRateLimitPercent(rateLimits.five_hour?.used_percentage);
  const sevenDay = parseRateLimitPercent(rateLimits.seven_day?.used_percentage);
  if (fiveHour === null && sevenDay === null) return null;

  return {
    fiveHour,
    sevenDay,
    fiveHourResetAt: parseRateLimitResetAt(rateLimits.five_hour?.resets_at),
    sevenDayResetAt: parseRateLimitResetAt(rateLimits.seven_day?.resets_at),
  };
}

/**
 * @param {string} modelId
 * @returns {string|null}
 */
function normalizeBedrockModelLabel(modelId) {
  if (!isBedrockModelId(modelId)) return null;

  const lowercaseId = modelId.toLowerCase();
  const claudePrefix = 'anthropic.claude-';
  const claudeIndex = lowercaseId.indexOf(claudePrefix);
  if (claudeIndex === -1) return null;

  let suffix = lowercaseId.slice(claudeIndex + claudePrefix.length);
  suffix = suffix.replace(/-v\d+:\d+$/, '');
  suffix = suffix.replace(/-\d{8}$/, '');

  const tokens = suffix.split('-').filter(Boolean);
  if (tokens.length === 0) return null;

  const familyIndex = tokens.findIndex(t => t === 'haiku' || t === 'sonnet' || t === 'opus');
  if (familyIndex === -1) return null;

  const family = tokens[familyIndex];
  const beforeVersion = readNumericVersion(tokens, familyIndex - 1, -1).reverse();
  const afterVersion = readNumericVersion(tokens, familyIndex + 1, 1);
  const versionParts = beforeVersion.length >= afterVersion.length ? beforeVersion : afterVersion;
  const version = versionParts.length ? versionParts.join('.') : null;
  const familyLabel = family[0].toUpperCase() + family.slice(1);

  return version ? `Claude ${familyLabel} ${version}` : `Claude ${familyLabel}`;
}

/**
 * @param {string[]} tokens
 * @param {number} startIndex
 * @param {-1|1} step
 * @returns {string[]}
 */
function readNumericVersion(tokens, startIndex, step) {
  const parts = [];
  for (let i = startIndex; i >= 0 && i < tokens.length; i += step) {
    if (!/^\d+$/.test(tokens[i])) break;
    parts.push(tokens[i]);
    if (parts.length === 2) break;
  }
  return parts;
}

function finite(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}
