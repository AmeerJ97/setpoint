#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPromptCacheConfig, applyPromptCacheMode, normalizePromptCacheMode, resolveConfiguredModel } from '../data/prompt-cache.js';
import { inspectSkillSurface } from '../data/skill-surface.js';
import { getClaudeConfigDir } from '../data/paths.js';
import { collectVertexConfigState } from '../guard/vertex-config.js';
import { discoverAnthropicVertexModels, readDiscoveryCache, resolveLocations, VERTEX_DISCOVERY_FILE } from '../vertex/discovery.js';
import { estimateAgentsTokens, estimateMcpTokens, estimateMemoryTokens } from '../context/buckets.js';

export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env ?? process.env;
  const settingsPath = options.settingsPath ?? join(getClaudeConfigDir(), 'settings.json');
  const settings = readJson(settingsPath) ?? {};
  const [sub, ...rest] = argv;
  const json = rest.includes('--json') || sub === '--json';
  const command = sub && sub !== '--json' ? sub : 'status';

  let result;
  switch (command) {
    case 'status':
      result = statusResult(settings, env, settingsPath);
      break;
    case 'discover':
      result = await discoverResult(rest, settings, env);
      break;
    case 'use':
    case 'setup':
      result = useResult(rest, settings, env, settingsPath);
      break;
    case 'switch':
      result = switchResult(rest, settings, env, settingsPath);
      break;
    case 'cache':
      result = cacheResult(rest, settings, env, settingsPath);
      break;
    default:
      result = { ok: false, error: `unknown vertex command: ${command}` };
  }

  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderVertexResult(command, result));
  return result.ok ? 0 : 1;
}

export function statusResult(settings, env, settingsPath) {
  const mergedEnv = { ...env, ...(settings?.env ?? {}) };
  const vertex = collectVertexConfigState(mergedEnv, { settingsPath });
  const cache = inspectPromptCacheConfig(settings, mergedEnv);
  const skillSurface = inspectSkillSurface();
  const staticPrefixTokens = 15_000 + estimateAgentsTokens() + estimateMemoryTokens() + estimateMcpTokens();
  const discovery = readDiscoveryCache(vertex.requiredEnv.ANTHROPIC_VERTEX_PROJECT_ID?.value ?? settings.env?.ANTHROPIC_VERTEX_PROJECT_ID ?? null, resolveLocations('common'));
  return {
    ok: true,
    settingsPath,
    vertex,
    cache,
    activeAlias: settings.model ?? null,
    resolvedModel: resolveConfiguredModel(settings, mergedEnv),
    modelPins: {
      haiku: settings.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,
      sonnet: settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,
      opus: settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,
      primary: settings.env?.ANTHROPIC_MODEL ?? null,
    },
    staticPrefixTokens,
    skillSurface: {
      totalSkills: skillSurface.totalSkills,
      invalidSkills: skillSurface.invalidSkills,
      oversizedSkills: skillSurface.oversizedSkills,
      corpusTokens: skillSurface.corpusTokens,
      corpusLarge: skillSurface.corpusLarge,
    },
    discovery: discovery ? {
      path: VERTEX_DISCOVERY_FILE,
      lastUpdated: discovery.last_updated,
      modelCount: discovery.models.length,
      errors: discovery.errors,
    } : null,
  };
}

async function discoverResult(argv, settings, env) {
  const opts = parseVertexArgs(argv);
  const projectId = opts.project ?? settings.env?.ANTHROPIC_VERTEX_PROJECT_ID ?? env.ANTHROPIC_VERTEX_PROJECT_ID;
  const result = await discoverAnthropicVertexModels({
    projectId,
    regions: opts.regions ?? 'common',
    refresh: Boolean(opts.refresh),
    cacheOnly: Boolean(opts.cacheOnly),
    env,
    fetchImpl: opts.fetchImpl,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    cache: result.cache,
    snapshot: result.snapshot,
  };
}

function useResult(argv, settings, env, settingsPath) {
  const opts = parseVertexArgs(argv);
  const next = cloneSettings(settings);
  ensureEnv(next).CLAUDE_CODE_USE_VERTEX = '1';
  if (opts.project) ensureEnv(next).ANTHROPIC_VERTEX_PROJECT_ID = opts.project;
  if (opts.region) ensureEnv(next).CLOUD_ML_REGION = opts.region;
  if (opts.haiku) ensureEnv(next).ANTHROPIC_DEFAULT_HAIKU_MODEL = opts.haiku;
  if (opts.sonnet) ensureEnv(next).ANTHROPIC_DEFAULT_SONNET_MODEL = opts.sonnet;
  if (opts.opus) ensureEnv(next).ANTHROPIC_DEFAULT_OPUS_MODEL = opts.opus;
  if (opts.model) ensureEnv(next).ANTHROPIC_MODEL = opts.model;
  if (opts.active) next.model = opts.active;
  if (opts.cache) applyPromptCacheMode(next, opts.cache);
  if (opts.authRefresh) next.gcpAuthRefresh = opts.authRefresh;
  if (!opts.haiku && !opts.sonnet && !opts.opus) {
    hydrateDefaultPins(next);
  }
  writeSettings(settingsPath, next);
  return {
    ok: true,
    applied: true,
    settingsPath,
    vertex: collectVertexConfigState({ ...env, ...(next.env ?? {}) }, { settingsPath }),
    cache: inspectPromptCacheConfig(next, { ...env, ...(next.env ?? {}) }),
    activeAlias: next.model ?? null,
  };
}

function switchResult(argv, settings, env, settingsPath) {
  const [alias] = argv.filter(arg => !arg.startsWith('--'));
  if (!['haiku', 'sonnet', 'opus'].includes(String(alias ?? '').toLowerCase())) {
    return { ok: false, error: 'vertex switch requires one of: haiku, sonnet, opus' };
  }
  const next = cloneSettings(settings);
  next.model = alias.toLowerCase();
  hydrateDefaultPins(next);
  writeSettings(settingsPath, next);
  return {
    ok: true,
    applied: true,
    settingsPath,
    activeAlias: next.model,
    resolvedModel: resolveConfiguredModel(next, env),
  };
}

function cacheResult(argv, settings, env, settingsPath) {
  const [mode] = argv.filter(arg => !arg.startsWith('--'));
  const normalized = normalizePromptCacheMode(mode);
  if (!normalized) return { ok: false, error: 'vertex cache requires one of: off, 5m, 1h' };
  const next = cloneSettings(settings);
  hydrateDefaultPins(next);
  const activeModel = resolveConfiguredModel(next, env);
  if (normalized === '1h' && !inspectPromptCacheConfig(next, env, { activeModelId: activeModel }).supports1h) {
    return { ok: false, error: `1h prompt caching is not supported for ${activeModel ?? 'the active model'}` };
  }
  applyPromptCacheMode(next, normalized);
  writeSettings(settingsPath, next);
  return {
    ok: true,
    applied: true,
    settingsPath,
    cache: inspectPromptCacheConfig(next, env, { activeModelId: activeModel }),
  };
}

function parseVertexArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--json': break;
      case '--project': opts.project = argv[++i]; break;
      case '--region': opts.region = argv[++i]; break;
      case '--regions': opts.regions = argv[++i]; break;
      case '--refresh': opts.refresh = true; break;
      case '--cache-only': opts.cacheOnly = true; break;
      case '--haiku': opts.haiku = argv[++i]; break;
      case '--sonnet': opts.sonnet = argv[++i]; break;
      case '--opus': opts.opus = argv[++i]; break;
      case '--model': opts.model = argv[++i]; break;
      case '--active': opts.active = argv[++i]; break;
      case '--cache': opts.cache = argv[++i]; break;
      case '--auth-refresh': opts.authRefresh = argv[++i]; break;
      default: break;
    }
  }
  return opts;
}

function hydrateDefaultPins(settings) {
  const env = ensureEnv(settings);
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL ||= 'claude-haiku-4-5@20251001';
  env.ANTHROPIC_DEFAULT_SONNET_MODEL ||= 'claude-sonnet-4-6[1m]';
  env.ANTHROPIC_DEFAULT_OPUS_MODEL ||= 'claude-opus-4-7[1m]';
}

function renderVertexResult(command, result) {
  if (!result.ok) return `claude-ops vertex: ${result.error}\n`;
  if (command === 'discover') {
    const lines = [
      `claude-ops vertex discover: ${result.snapshot.models.length} models`,
      `project: ${result.snapshot.project_id}`,
      `locations: ${result.snapshot.scanned_locations.join(', ')}`,
    ];
    for (const model of result.snapshot.models.slice(0, 12)) {
      lines.push(`  ${model.location} ${model.modelId} cache:${model.supportsOneHourCache ? '1h' : '5m'} ctx:${model.contextWindow}`);
    }
    return `${lines.join('\n')}\n`;
  }
  if (command === 'status') {
    return `claude-ops vertex status: ${result.vertex.state}; model ${result.resolvedModel ?? 'unknown'}; cache ${result.cache.mode}; skills ${result.skillSurface.corpusTokens}t/${result.skillSurface.totalSkills}\n`;
  }
  if (command === 'switch') {
    return `claude-ops vertex switch: ${result.activeAlias} -> ${result.resolvedModel}\n`;
  }
  if (command === 'cache') {
    return `claude-ops vertex cache: ${result.cache.mode}\n`;
  }
  return `claude-ops vertex use: configured ${result.activeAlias ?? 'vertex'} cache ${result.cache.mode}\n`;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(path, `${path}.bak.${stamp}`);
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function cloneSettings(settings) {
  return JSON.parse(JSON.stringify(settings && typeof settings === 'object' ? settings : {}));
}

function ensureEnv(settings) {
  if (!settings.env || typeof settings.env !== 'object') settings.env = {};
  return settings.env;
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0));
}
