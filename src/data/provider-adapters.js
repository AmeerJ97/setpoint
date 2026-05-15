/**
 * Provider metadata registry for cost-metered Claude Code sessions.
 *
 * This is intentionally not a billing integration. It gives doctor/HUD
 * callers a stable shape for auth/provider display and future credentialed
 * readers while the first pass stays local-telemetry only.
 */

const ADAPTERS = {
  'api-key': {
    id: 'api-key',
    label: 'API',
    billingSource: 'statusline-cost-or-local-estimate',
    credentialedBilling: false,
    authoritativeSignals: ['statusLine.cost.total_cost_usd'],
  },
  'auth-token': {
    id: 'auth-token',
    label: 'Token',
    billingSource: 'statusline-cost-or-local-estimate',
    credentialedBilling: false,
    authoritativeSignals: ['statusLine.cost.total_cost_usd'],
  },
  gateway: {
    id: 'gateway',
    label: 'Gateway',
    billingSource: 'statusline-cost-or-local-estimate',
    credentialedBilling: false,
    authoritativeSignals: ['statusLine.cost.total_cost_usd'],
  },
  bedrock: {
    id: 'bedrock',
    label: 'Bedrock',
    billingSource: 'local-estimate',
    credentialedBilling: false,
  },
  vertex: {
    id: 'vertex',
    label: 'Vertex',
    billingSource: 'vertex-api-snapshot-or-local-synthetic',
    credentialedBilling: false,
    authoritativeSignals: ['CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE'],
  },
  foundry: {
    id: 'foundry',
    label: 'Foundry',
    billingSource: 'local-estimate',
    credentialedBilling: false,
  },
  console: {
    id: 'console',
    label: 'Console',
    billingSource: 'statusline-cost-or-local-estimate',
    credentialedBilling: false,
    authoritativeSignals: ['statusLine.cost.total_cost_usd'],
  },
  subscription: {
    id: 'subscription',
    label: 'Subscription',
    billingSource: 'statusline-rate-limits',
    credentialedBilling: false,
  },
  unknown: {
    id: 'unknown',
    label: 'Unknown',
    billingSource: 'local-estimate',
    credentialedBilling: false,
  },
};

/**
 * @param {string|undefined|null} authProvider
 * @returns {{id:string,label:string,billingSource:string,credentialedBilling:boolean}}
 */
export function getProviderAdapter(authProvider) {
  return ADAPTERS[authProvider] ?? ADAPTERS.unknown;
}

export function listProviderAdapters() {
  return Object.values(ADAPTERS);
}
