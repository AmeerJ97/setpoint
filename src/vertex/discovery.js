import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PLUGIN_DIR } from '../data/paths.js';
import { supportsOneHourPromptCache, contextWindowForModel } from '../data/prompt-cache.js';

export const VERTEX_DISCOVERY_FILE = join(PLUGIN_DIR, 'vertex-discovery.json');
export const COMMON_LOCATIONS = ['global', 'us-east5', 'us-central1', 'us-west4', 'europe-west1', 'europe-west4', 'europe-west9', 'asia-northeast1'];

export async function discoverAnthropicVertexModels({ projectId, regions = 'common', refresh = false, cacheOnly = false, env = process.env, fetchImpl = fetch } = {}) {
  if (!projectId) return { ok: false, error: 'missing Vertex project id' };
  const locations = resolveLocations(regions);
  if (!refresh && !cacheOnly) {
    const cached = readDiscoveryCache(projectId, locations);
    if (cached) return { ok: true, cache: true, snapshot: cached };
  }
  if (cacheOnly) {
    const cached = readDiscoveryCache(projectId, locations);
    return cached ? { ok: true, cache: true, snapshot: cached } : { ok: false, error: 'no cached Vertex discovery snapshot' };
  }

  const token = readAdcToken(env);
  if (!token.ok) return token;
  const discovered = [];
  const errors = [];
  for (const location of locations) {
    try {
      const url = `https://${hostForLocation(location)}/v1beta1/publishers/anthropic/models?pageSize=200`;
      const response = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token.token}`,
          'x-goog-user-project': projectId,
        },
      });
      const body = await response.text();
      if (!response.ok) {
        errors.push(`${location}: ${compactError(body) || response.status}`);
        continue;
      }
      const parsed = JSON.parse(body);
      discovered.push(...normalizeDiscoveryResponse(parsed, location));
    } catch (error) {
      errors.push(`${location}: ${error.message}`);
    }
  }

  const snapshot = {
    schema_version: 1,
    project_id: projectId,
    scanned_locations: locations,
    last_updated: new Date().toISOString(),
    ttl_hours: 1,
    models: dedupeModels(discovered),
    errors,
  };
  writeJsonAtomic(VERTEX_DISCOVERY_FILE, snapshot);
  return { ok: true, cache: false, snapshot };
}

export function readDiscoveryCache(projectId, locations, now = Date.now()) {
  if (!existsSync(VERTEX_DISCOVERY_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(VERTEX_DISCOVERY_FILE, 'utf8'));
    const ageMs = now - Date.parse(data.last_updated ?? 0);
    const ttlMs = Number(data.ttl_hours ?? 1) * 3600_000;
    const sameProject = data.project_id === projectId;
    const sameLocations = JSON.stringify(data.scanned_locations ?? []) === JSON.stringify(locations);
    if (sameProject && sameLocations && Number.isFinite(ageMs) && ageMs < ttlMs) return data;
  } catch {
    return null;
  }
  return null;
}

export function normalizeDiscoveryResponse(payload, location) {
  const out = [];
  for (const model of Array.isArray(payload?.publisherModels) ? payload.publisherModels : []) {
    const name = String(model.name ?? '');
    const baseName = name.split('/').pop() || name;
    const template = String(model.publisherModelTemplate ?? '');
    const modelId = template.includes('/models/')
      ? template.split('/models/').pop()
      : (model.versionId && !baseName.includes('@') ? `${baseName}@${model.versionId}` : baseName);
    out.push({
      location,
      modelId,
      displayName: model.displayName ?? baseName,
      launchStage: model.launchStage ?? null,
      supportsOneHourCache: supportsOneHourPromptCache(modelId),
      contextWindow: contextWindowForModel(modelId),
      requestAccessUrl: actionReference(model.supportedActions, 'requestAccess', location),
      studioUrl: actionReference(model.supportedActions, 'openGenerationAiStudio', location),
      notebookUrl: actionReference(model.supportedActions, 'openNotebook', location),
    });
  }
  return out;
}

export function resolveLocations(regions) {
  const raw = String(regions ?? 'common').trim().toLowerCase();
  if (raw === 'common') return COMMON_LOCATIONS;
  if (raw === 'all') return [...COMMON_LOCATIONS, 'us-west1', 'europe-west2', 'asia-southeast1', 'asia-south1', 'us', 'eu'];
  return raw.split(',').map(part => part.trim()).filter(Boolean);
}

export function hostForLocation(location) {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (location === 'us' || location === 'eu') return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

function readAdcToken(env) {
  const result = spawnSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8', env });
  if (result.error?.code === 'ENOENT') return { ok: false, error: 'gcloud not found on PATH' };
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || 'failed to read ADC token').trim() };
  return { ok: true, token: String(result.stdout).trim() };
}

function actionReference(actions, key, location) {
  return actions?.[key]?.references?.[location]?.uri
    ?? actions?.[key]?.references?.global?.uri
    ?? null;
}

function dedupeModels(models) {
  const seen = new Map();
  for (const model of models) seen.set(`${model.location}:${model.modelId}`, model);
  return [...seen.values()].sort((a, b) => a.location.localeCompare(b.location) || a.modelId.localeCompare(b.modelId));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function compactError(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message ?? text.slice(0, 120);
  } catch {
    return text.slice(0, 120);
  }
}
