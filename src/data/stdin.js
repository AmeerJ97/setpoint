/**
 * @typedef {object} StdinData
 * @property {string} [session_id]
 * @property {string} [transcript_path]
 * @property {string} [cwd]
 * @property {{ id?: string, display_name?: string }} [model]
 * @property {{ context_window_size?: number, used_percentage?: number|null, remaining_percentage?: number|null, current_usage?: { input_tokens?: number, output_tokens?: number, cache_creation_input_tokens?: number, cache_read_input_tokens?: number }|null }} [context_window]
 * @property {{ five_hour?: { used_percentage?: number|null, resets_at?: number|null }|null, seven_day?: { used_percentage?: number|null, resets_at?: number|null }|null }|null} [rate_limits]
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
 * @param {StdinData} stdin
 * @returns {number}
 */
export function getTotalTokens(stdin) {
  const usage = stdin.context_window?.current_usage;
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
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
  return null;
}

/**
 * @param {StdinData} stdin
 * @returns {number}
 */
export function getContextPercent(stdin) {
  const native = getNativePercent(stdin);
  if (native !== null) return native;

  const size = stdin.context_window?.context_window_size;
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

  const size = stdin.context_window?.context_window_size;
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
