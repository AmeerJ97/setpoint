/**
 * Vertex AI configuration audit.
 *
 * Guard enforcement owns Claude JSON/GrowthBook values. Vertex access is
 * mostly environment-driven, so this module reports config inventory and
 * drift without mutating env vars or installing policy-bypass instructions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from '../data/paths.js';

export const VERTEX_REQUIRED_ENV_KEYS = [
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
];

export const VERTEX_REGION_ENV_KEYS = [
  'CLOUD_ML_REGION',
  'VERTEX_REGION_CLAUDE_HAIKU_4_5',
  'VERTEX_REGION_CLAUDE_4_6_SONNET',
  'VERTEX_REGION_CLAUDE_4_7_OPUS',
  'VERTEX_REGION_CLAUDE_3_5_HAIKU',
  'VERTEX_REGION_CLAUDE_3_5_SONNET',
  'VERTEX_REGION_CLAUDE_3_7_SONNET',
  'VERTEX_REGION_CLAUDE_4_0_OPUS',
  'VERTEX_REGION_CLAUDE_4_0_SONNET',
  'VERTEX_REGION_CLAUDE_4_1_OPUS',
];

export const VERTEX_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

export const VERTEX_OPTIONAL_ENV_KEYS = [
  'ANTHROPIC_VERTEX_BASE_URL',
];

export const VERTEX_ENV_KEYS = [
  ...VERTEX_REQUIRED_ENV_KEYS,
  ...VERTEX_REGION_ENV_KEYS,
  ...VERTEX_MODEL_ENV_KEYS,
  ...VERTEX_OPTIONAL_ENV_KEYS,
];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ settingsPath?: string }} [options]
 */
export function collectVertexConfigState(env = process.env, options = {}) {
  const settingsPath = options.settingsPath ?? join(getClaudeConfigDir(), 'settings.json');
  const settings = readJson(settingsPath) ?? {};
  const regionEnvKeys = collectRegionEnvKeys(env);
  const envKeys = [
    ...VERTEX_REQUIRED_ENV_KEYS,
    ...regionEnvKeys,
    ...VERTEX_MODEL_ENV_KEYS,
    ...VERTEX_OPTIONAL_ENV_KEYS,
  ];
  const presentEnv = Object.fromEntries(envKeys.map(key => [key, envValueState(env, key)]));
  const explicitlyDisabled = explicitFalse(env.CLAUDE_CODE_USE_VERTEX)
    || (!truthy(env.CLAUDE_CODE_USE_VERTEX) && explicitFalse(settings?.env?.CLAUDE_CODE_USE_VERTEX));
  const configured = truthy(env.CLAUDE_CODE_USE_VERTEX)
    || envKeys.some(key => presentEnv[key].present)
    || hasVertexSettings(settings);
  const active = configured && !explicitlyDisabled;
  const missingRequired = active ? missingVertexRequirements(presentEnv) : [];
  const modelMapperKeys = VERTEX_MODEL_ENV_KEYS.filter(key => presentEnv[key].present);
  const regionKeys = regionEnvKeys.filter(key => presentEnv[key].present);
  const apiTelemetryBypass = isApiTelemetryBypassEnabled(env);
  const state = explicitlyDisabled ? 'disabled'
    : !configured ? 'inactive'
      : missingRequired.length > 0 ? 'drift' : 'held';

  return {
    configured,
    active,
    explicitlyDisabled,
    state,
    missingRequired,
    requiredEnv: Object.fromEntries(VERTEX_REQUIRED_ENV_KEYS.map(key => [key, presentEnv[key]])),
    regionEnv: Object.fromEntries(regionEnvKeys.map(key => [key, presentEnv[key]])),
    modelEnv: Object.fromEntries(VERTEX_MODEL_ENV_KEYS.map(key => [key, presentEnv[key]])),
    optionalEnv: Object.fromEntries(VERTEX_OPTIONAL_ENV_KEYS.map(key => [key, presentEnv[key]])),
    modelMapperKeys,
    regionKeys,
    settings: {
      path: settingsPath,
      exists: existsSync(settingsPath),
      vertexKeys: collectVertexSettingsKeys(settings),
      customInstructionsBypass: containsBypassInstruction(settings),
    },
    apiTelemetryBypass,
    auditOnly: true,
    detail: explicitlyDisabled
      ? 'Vertex env/settings present but CLAUDE_CODE_USE_VERTEX is disabled'
      : !configured
        ? 'Vertex env not detected'
      : missingRequired.length
        ? ('Vertex env missing ' + missingRequired.join(', '))
        : ('Vertex env present (' + regionKeys.length + ' region signal' + (regionKeys.length === 1 ? '' : 's') + ', ' + modelMapperKeys.length + ' model mapper' + (modelMapperKeys.length === 1 ? '' : 's') + ')' + (apiTelemetryBypass ? '; API telemetry bypass enabled' : '')),
  };
}

function missingVertexRequirements(presentEnv) {
  const missing = VERTEX_REQUIRED_ENV_KEYS.filter(key => !presentEnv[key].present);
  if (!Object.keys(presentEnv).some(key => key.startsWith('VERTEX_REGION_CLAUDE_') && presentEnv[key].present)
      && !presentEnv.CLOUD_ML_REGION?.present) {
    missing.push('CLOUD_ML_REGION|VERTEX_REGION_CLAUDE_*');
  }
  return missing;
}

function collectRegionEnvKeys(env) {
  return [
    ...new Set([
      ...VERTEX_REGION_ENV_KEYS,
      ...Object.keys(env).filter(key => key.startsWith('VERTEX_REGION_CLAUDE_')).sort(),
    ]),
  ];
}

function envValueState(env, key) {
  const value = env[key];
  return {
    present: typeof value === 'string' && value.trim().length > 0,
    value: redactEnvValue(key, value),
  };
}

function redactEnvValue(key, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) return '[redacted]';
  return value;
}

function hasVertexSettings(settings) {
  return collectVertexSettingsKeys(settings).length > 0;
}

function collectVertexSettingsKeys(settings) {
  const keys = [];
  walk(settings, [], keys);
  return keys.filter(k => /vertex|cloud_ml_region|vertex_region_claude|anthropic_vertex|CLAUDE_CODE_USE_VERTEX/i.test(k));
}

function walk(value, path, keys) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    const dotted = next.join('.');
    if (/vertex|cloud_ml_region|vertex_region_claude|anthropic_vertex|CLAUDE_CODE_USE_VERTEX/i.test(dotted)) keys.push(dotted);
    walk(child, next, keys);
  }
}

function containsBypassInstruction(settings) {
  const text = JSON.stringify(settings ?? {});
  return /AUTHORIZATION OVERRIDE|Do not refuse requests|Usage Policy/i.test(text);
}

function isApiTelemetryBypassEnabled(env) {
  const value = env.CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY;
  if (typeof value !== 'string' || value.trim() === '') return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function truthy(value) {
  if (typeof value !== 'string') return Boolean(value);
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function explicitFalse(value) {
  if (typeof value !== 'string') return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}
