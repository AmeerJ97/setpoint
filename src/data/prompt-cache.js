import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from './paths.js';

export function inspectPromptCacheConfig(settings = null, env = process.env, options = {}) {
  const activeModelId = options.activeModelId ?? resolveConfiguredModel(settings ?? readSettings(options.settingsPath), env);
  const disable = readSettingThenEnv('DISABLE_PROMPT_CACHING', settings, env);
  const oneHour = readSettingThenEnv('ENABLE_PROMPT_CACHING_1H', settings, env);
  const supports1h = supportsOneHourPromptCache(activeModelId);
  const mode = truthy(disable.value) ? 'off' : truthy(oneHour.value) ? '1h' : '5m';
  const recommendedMode = mode === 'off' ? '5m' : (supports1h ? '1h' : '5m');
  return {
    activeModelId,
    mode,
    recommendedMode,
    disablePromptCaching: disable,
    enablePromptCaching1h: oneHour,
    supports1h,
  };
}

export function applyPromptCacheMode(settings, mode) {
  const normalized = normalizePromptCacheMode(mode);
  if (!normalized) throw new Error(`unknown prompt cache mode: ${mode}`);
  const next = settings && typeof settings === 'object' ? settings : {};
  const env = next.env && typeof next.env === 'object' ? { ...next.env } : {};
  if (normalized === 'off') {
    env.DISABLE_PROMPT_CACHING = '1';
    delete env.ENABLE_PROMPT_CACHING_1H;
  } else if (normalized === '1h') {
    env.DISABLE_PROMPT_CACHING = '0';
    env.ENABLE_PROMPT_CACHING_1H = '1';
  } else {
    env.DISABLE_PROMPT_CACHING = '0';
    delete env.ENABLE_PROMPT_CACHING_1H;
  }
  next.env = env;
  return next;
}

export function normalizePromptCacheMode(mode) {
  const value = String(mode ?? '').trim().toLowerCase();
  if (value === 'off') return 'off';
  if (value === '1h' || value === '60m') return '1h';
  if (value === '5m' || value === 'default' || value === 'auto') return '5m';
  return null;
}

export function supportsOneHourPromptCache(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return false;
  const unsupportedPrefixes = [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-opus',
  ];
  return !unsupportedPrefixes.some(prefix => normalized.startsWith(prefix));
}

export function contextWindowForModel(modelId) {
  const raw = String(modelId ?? '');
  if (/\[1m\]/i.test(raw)) return 1_000_000;
  return 200_000;
}

export function resolveConfiguredModel(settings = null, env = process.env) {
  const s = settings ?? readSettings();
  const persistentEnv = s?.env ?? {};
  if (nonEmpty(persistentEnv.ANTHROPIC_MODEL)) return String(persistentEnv.ANTHROPIC_MODEL);
  if (nonEmpty(env.ANTHROPIC_MODEL)) return String(env.ANTHROPIC_MODEL);

  const alias = String(s?.model ?? '').trim().toLowerCase();
  if (alias === 'haiku') {
    return firstNonEmpty(
      persistentEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      persistentEnv.ANTHROPIC_SMALL_FAST_MODEL,
      env.ANTHROPIC_SMALL_FAST_MODEL,
    );
  }
  if (alias === 'sonnet') {
    return firstNonEmpty(
      persistentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    );
  }
  if (alias === 'opus') {
    return firstNonEmpty(
      persistentEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    );
  }
  if (alias.startsWith('claude-')) return alias;

  return firstNonEmpty(
    persistentEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    persistentEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    persistentEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  );
}

export function normalizeModelId(modelId) {
  return String(modelId ?? '')
    .trim()
    .replace(/\[1m\]/gi, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function readSettingThenEnv(key, settings, env) {
  const settingsValue = settings?.env?.[key];
  if (nonEmpty(settingsValue)) return { source: 'settings.env', value: String(settingsValue) };
  const envValue = env?.[key];
  if (nonEmpty(envValue)) return { source: 'env', value: String(envValue) };
  return { source: 'default', value: null };
}

function readSettings(settingsPath = join(getClaudeConfigDir(), 'settings.json')) {
  try { return JSON.parse(readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function truthy(value) {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function nonEmpty(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (nonEmpty(value)) return String(value);
  }
  return null;
}
