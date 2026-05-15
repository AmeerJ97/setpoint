/**
 * Mode detection — determines how the active Claude Code session is
 * authenticated and whether billing data is quota-window or cost-metered.
 *
 * Subscription mode: stdin.rate_limits is present → 5h/7d rolling windows apply
 * API billing mode:  stdin.rate_limits is absent  → cost/context telemetry applies
 * Cloud/provider mode: env/model hints identify Bedrock, Vertex, Foundry, or gateway
 *
 * Detection is intentionally cheap (two property reads + one env check)
 * because it runs on every HUD render cycle.
 *
 * @module src/data/mode
 */

/**
 * @typedef {'max' | 'api' | 'bedrock' | 'unknown'} SessionMode
 * @typedef {'subscription' | 'console' | 'api-key' | 'auth-token' | 'gateway' | 'bedrock' | 'vertex' | 'foundry' | 'unknown'} AuthProvider
 * @typedef {'quota-window' | 'cost-metered'} BillingSignal
 * @typedef {'anthropic-pro'|'anthropic-api'|'anthropic-console'|'gateway'|'bedrock'|'vertex-ai'|'foundry'|'unknown'} RuntimeBackend
 * @typedef {'server-rate-limits'|'statusline-cost'|'local-cost'|'local-synthetic'|'vertex-api'|'vertex-metrics-estimate'|'unknown'} TelemetryAuthority
 * @typedef {{ key:string, present:boolean, source?:string }} DetectionSignal
 * @typedef {{ authProvider: AuthProvider, billingSignal: BillingSignal, mode: SessionMode, backend: RuntimeBackend, telemetryAuthority: TelemetryAuthority, backendLabel: string, detection: { confidence:'high'|'medium'|'low', signals:DetectionSignal[] } }} RuntimeMode
 */

/**
 * Detect the current runtime mode from stdin, environment, and settings hints.
 *
 * Priority:
 *   1. Explicit cloud/provider env wins for authProvider.
 *   2. Gateway/base URL wins over raw API key/auth token labelling.
 *   3. rate_limits present means quota-window billing even if auth is unclear.
 *   4. rate_limits absent means cost-metered billing.
 *
 * @param {object|null} stdin - parsed stdin payload from Claude Code
 * @param {NodeJS.ProcessEnv} [env] - process.env or a test substitute
 * @param {{ apiKeyHelper?: boolean }} [options]
 * @returns {RuntimeMode}
 */
export function detectRuntimeMode(stdin, env = process.env, options = {}) {
  const explicitCloudProvider = hasExplicitCloudProvider(stdin, env);
  const billingSignal = hasRateLimits(stdin) && !explicitCloudProvider
    ? 'quota-window'
    : 'cost-metered';
  const detection = detectAuthProvider(stdin, env, options, billingSignal);
  const authProvider = detection.authProvider;
  const backend = runtimeBackend(authProvider, billingSignal);
  const telemetryAuthority = runtimeTelemetryAuthority(backend, billingSignal, env);
  return {
    authProvider,
    billingSignal,
    mode: legacyMode(authProvider, billingSignal),
    backend,
    telemetryAuthority,
    backendLabel: runtimeBackendLabel({ backend, authProvider, billingSignal }),
    detection: {
      confidence: detection.confidence,
      signals: detection.signals,
    },
  };
}

/**
 * Legacy mode facade used by older HUD/advisor call sites.
 *
 * @param {object|null} stdin
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ apiKeyHelper?: boolean }} [options]
 * @returns {SessionMode}
 */
export function detectMode(stdin, env = process.env, options = {}) {
  return detectRuntimeMode(stdin, env, options).mode;
}

/**
 * @param {object|null} stdin
 * @param {NodeJS.ProcessEnv} env
 * @param {{ apiKeyHelper?: boolean }} options
 * @param {BillingSignal} billingSignal
 * @returns {AuthProvider}
 */
function detectAuthProvider(stdin, env, options, billingSignal) {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) return detected('bedrock', 'high', signal('CLAUDE_CODE_USE_BEDROCK'));
  if (hasVertexSignal(env)) return detected('vertex', truthy(env.CLAUDE_CODE_USE_VERTEX) ? 'high' : 'medium', vertexSignals(env));
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY)) return detected('foundry', 'high', signal('CLAUDE_CODE_USE_FOUNDRY'));

  const modelId = stdin?.model?.id ?? '';
  if (modelId.toLowerCase().includes('anthropic.claude-')) return detected('bedrock', 'medium', [{ key: 'model.id', present: true, source: 'bedrock-model-id' }]);

  if (nonEmpty(env.ANTHROPIC_BASE_URL)) return detected('gateway', 'high', signal('ANTHROPIC_BASE_URL'));
  if (nonEmpty(env.ANTHROPIC_AUTH_TOKEN)) return detected('auth-token', 'high', signal('ANTHROPIC_AUTH_TOKEN'));
  if (nonEmpty(env.ANTHROPIC_API_KEY)) return detected('api-key', 'high', signal('ANTHROPIC_API_KEY'));
  if (options.apiKeyHelper) return detected('api-key', 'medium', [{ key: 'apiKeyHelper', present: true, source: 'settings' }]);

  if (billingSignal === 'quota-window') return detected('subscription', 'high', [{ key: 'rate_limits', present: true, source: 'statusLine' }]);
  if (stdin) return detected('console', 'low', [{ key: 'stdin', present: true, source: 'statusLine' }]);
  return detected('unknown', 'low', []);
}

/**
 * @param {AuthProvider} authProvider
 * @param {BillingSignal} billingSignal
 * @returns {SessionMode}
 */
function legacyMode(authProvider, billingSignal) {
  if (authProvider === 'bedrock') return 'bedrock';
  if (authProvider === 'unknown') return 'unknown';
  if (billingSignal === 'quota-window') return 'max';
  if (billingSignal === 'cost-metered') return 'api';
  return 'unknown';
}

/**
 * @param {object|null|undefined} stdin
 * @returns {boolean}
 */
export function hasRateLimits(stdin) {
  return stdin?.rate_limits !== undefined && stdin?.rate_limits !== null;
}

/**
 * @param {object|null} stdin
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ apiKeyHelper?: boolean }} [options]
 * @returns {boolean}
 */
export function isCostMetered(stdin, env = process.env, options = {}) {
  return detectRuntimeMode(stdin, env, options).billingSignal === 'cost-metered';
}

/**
 * True when Claude Code is using the raw Anthropic API (pay-per-token).
 * In this mode, rate_limits are absent from stdin and the 5h/7d rolling
 * window gauges must be replaced by cost-based equivalents.
 *
 * @param {object|null} stdin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isApiMode(stdin, env = process.env) {
  const m = detectMode(stdin, env);
  return m === 'api' || m === 'unknown';
}

/**
 * True when the subscription rolling-window data is available.
 * Only 'max' mode has reliable rate_limits; bedrock and api do not.
 *
 * @param {object|null} stdin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isMaxMode(stdin, env = process.env) {
  return detectMode(stdin, env) === 'max';
}

/**
 * @param {AuthProvider} provider
 * @returns {string|null}
 */
export function authProviderLabel(provider) {
  switch (provider) {
    case 'console': return 'Console';
    case 'api-key': return 'API';
    case 'auth-token': return 'Token';
    case 'gateway': return 'Gateway';
    case 'bedrock': return 'Bedrock';
    case 'vertex': return 'Vertex';
    case 'foundry': return 'Foundry';
    case 'subscription': return null;
    default: return provider ? 'Cost' : null;
  }
}

/**
 * Coarse transport tier: which "place" Claude Code is talking to.
 * Used by the HUD Model line to pick a glyph and color so the user can tell at
 * a glance whether they're on Vertex, direct Anthropic, a proxy, or another
 * cloud. Returns null when the auth path is undetermined.
 *
 * @param {AuthProvider} provider
 * @returns {'vertex'|'anthropic'|'gateway'|'bedrock'|'foundry'|null}
 */
export function authProviderTier(provider) {
  switch (provider) {
    case 'vertex': return 'vertex';
    case 'bedrock': return 'bedrock';
    case 'foundry': return 'foundry';
    case 'gateway': return 'gateway';
    case 'console':
    case 'api-key':
    case 'auth-token':
    case 'subscription':
      return 'anthropic';
    default: return null;
  }
}

/**
 * Display name for the tier (Option A: semantic label).
 *
 * @param {ReturnType<typeof authProviderTier>} tier
 * @returns {string|null}
 */
export function authProviderTierLabel(tier) {
  switch (tier) {
    case 'vertex': return 'Vertex';
    case 'anthropic': return 'Anthropic';
    case 'gateway': return 'Gateway';
    case 'bedrock': return 'Bedrock';
    case 'foundry': return 'Foundry';
    default: return null;
  }
}

/**
 * Single-char glyph for the tier (Option B: leading visual marker).
 *
 * @param {ReturnType<typeof authProviderTier>} tier
 * @returns {string|null}
 */
export function authProviderTierGlyph(tier) {
  switch (tier) {
    case 'vertex': return '⬢';     // hex: Google cloud
    case 'anthropic': return '▲';  // triangle: Anthropic logo
    case 'gateway': return '↻';    // rotation: proxy
    case 'bedrock': return '▣';    // boxed: AWS
    case 'foundry': return '⬡';    // outlined hex: Azure
    default: return null;
  }
}

/**
 * @param {AuthProvider} authProvider
 * @param {BillingSignal} billingSignal
 * @returns {RuntimeBackend}
 */
export function runtimeBackend(authProvider, billingSignal) {
  if (authProvider === 'vertex') return 'vertex-ai';
  if (authProvider === 'bedrock') return 'bedrock';
  if (authProvider === 'foundry') return 'foundry';
  if (authProvider === 'gateway') return 'gateway';
  if (billingSignal === 'quota-window') return 'anthropic-pro';
  if (authProvider === 'api-key' || authProvider === 'auth-token') return 'anthropic-api';
  if (authProvider === 'console') return 'anthropic-console';
  return 'unknown';
}

/**
 * @param {RuntimeBackend} backend
 * @param {BillingSignal} billingSignal
 * @returns {TelemetryAuthority}
 */
export function runtimeTelemetryAuthority(backend, billingSignal, env = process.env) {
  if (backend === 'vertex-ai') {
    // Vertex snapshots must be parsed, freshness-checked, and matched against
    // the current project/region/model before they become authoritative. That
    // happens in analytics/vertex-telemetry; mode detection stays cheap.
    return 'local-synthetic';
  }
  if (billingSignal === 'quota-window') return 'server-rate-limits';
  if (nonEmpty(env.CLAUDE_OPS_STATUSLINE_COST_AUTHORITY)) return 'statusline-cost';
  if (billingSignal === 'cost-metered') return 'local-cost';
  return 'unknown';
}

/**
 * @param {{ backend?: RuntimeBackend|null, authProvider?: AuthProvider|null, billingSignal?: BillingSignal|null }|null|undefined} runtime
 * @returns {string}
 */
export function runtimeBackendLabel(runtime) {
  const backend = runtime?.backend ?? runtimeBackend(runtime?.authProvider ?? 'unknown', runtime?.billingSignal ?? 'cost-metered');
  switch (backend) {
    case 'anthropic-pro': return '[ANTHROPIC-PRO]';
    case 'anthropic-api': return '[ANTHROPIC-API]';
    case 'anthropic-console': return '[ANTHROPIC-CONSOLE]';
    case 'gateway': return '[GATEWAY]';
    case 'bedrock': return '[BEDROCK]';
    case 'vertex-ai': return '[VERTEX-AI]';
    case 'foundry': return '[FOUNDRY]';
    default: return '[COST]';
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasExplicitCloudProvider(stdin, env) {
  return truthy(env.CLAUDE_CODE_USE_BEDROCK)
    || hasVertexSignal(env)
    || truthy(env.CLAUDE_CODE_USE_FOUNDRY)
    || String(stdin?.model?.id ?? '').toLowerCase().includes('anthropic.claude-');
}

function hasVertexSignal(env) {
  if (explicitFalse(env.CLAUDE_CODE_USE_VERTEX)) return false;
  return truthy(env.CLAUDE_CODE_USE_VERTEX)
    || nonEmpty(env.ANTHROPIC_VERTEX_PROJECT_ID)
    || nonEmpty(env.ANTHROPIC_VERTEX_BASE_URL)
    || Object.keys(env).some(key => key.startsWith('VERTEX_REGION_CLAUDE_') && nonEmpty(env[key]));
}

function vertexSignals(env) {
  return [
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'ANTHROPIC_VERTEX_BASE_URL',
    'CLOUD_ML_REGION',
    ...Object.keys(env).filter(key => key.startsWith('VERTEX_REGION_CLAUDE_')).sort(),
  ].filter(key => key === 'CLAUDE_CODE_USE_VERTEX' ? truthy(env[key]) : nonEmpty(env[key]))
    .map(key => ({ key, present: true, source: 'env' }));
}

function signal(key) {
  return [{ key, present: true, source: 'env' }];
}

function detected(authProvider, confidence, signals) {
  return { authProvider, confidence, signals };
}

function truthy(value) {
  if (typeof value !== 'string') return Boolean(value);
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function explicitFalse(value) {
  return typeof value === 'string' && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}
