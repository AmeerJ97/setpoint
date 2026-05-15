import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeConfigDir } from '../data/paths.js';
import { loadGuardControlManifest } from './guard-manifest.js';
import { collectVertexConfigState } from './vertex-config.js';

/**
 * Validate documented guard controls without mutating Claude Code config.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ settingsPath?: string }} [options]
 */
export function collectGuardValidationState(env = process.env, options = {}) {
  const manifest = loadGuardControlManifest();
  const settingsPath = options.settingsPath ?? join(getClaudeConfigDir(), 'settings.json');
  const settings = readJson(settingsPath) ?? {};
  const categories = Object.entries(manifest.categories ?? {}).map(([category, meta]) => {
    const officialControls = (meta.officialControls ?? []).map(control =>
      evaluateControl(control, env, settings)
    );
    return {
      category,
      claim: meta.claim ?? '',
      authority: meta.authority ?? 'internal-growthbook',
      enforcement: meta.enforcement ?? 'internal-opt-in',
      risk: meta.risk ?? 'medium',
      state: categoryState(officialControls),
      officialControls,
    };
  });
  const controls = categories.flatMap(c => c.officialControls.map(control => ({
    category: c.category,
    ...control,
  })));
  const summary = summarize(categories, controls);
  const vertexConfig = collectVertexConfigState(env, { settingsPath });

  return {
    generatedAt: new Date().toISOString(),
    posture: manifest.posture ?? 'audit-first',
    docs: manifest.docs ?? [],
    settings: {
      path: settingsPath,
      exists: existsSync(settingsPath),
    },
    summary,
    categories,
    controls,
    vertexConfig,
  };
}

export function buildGuardPresentationSummary(rows = [], validationState = null) {
  const categories = Array.isArray(rows) ? rows : [];
  const validation = validationState ?? {
    summary: {
      categories: { total: 0, docsBacked: 0, internalOnly: 0, held: 0, drift: 0, info: 0 },
      controls: { total: 0, held: 0, drift: 0, info: 0, absent: 0 },
    },
    controls: [],
  };
  const skippedRows = categories.filter(r => r.state === 'skipped');
  const internalOnlyRows = categories.filter(r => (r.officialControls ?? []).length === 0);
  const rawHeld = categories.filter(r => r.state === 'held').length;
  const rawDrift = categories.filter(r => r.state === 'drift').length;

  return {
    total: categories.length,
    official: {
      categories: validation.summary.categories,
      controls: validation.summary.controls,
      driftControls: (validation.controls ?? []).filter(c => c.state === 'drift'),
    },
    internal: {
      total: internalOnlyRows.length,
      held: internalOnlyRows.filter(r => r.state === 'held').length,
      probe: internalOnlyRows.filter(r => r.state === 'drift').length,
      skipped: internalOnlyRows.filter(r => r.state === 'skipped').length,
    },
    skipped: {
      total: skippedRows.length,
      categories: skippedRows.map(r => ({
        category: r.category,
        reason: r.skipReason ?? null,
      })),
    },
    raw: {
      held: rawHeld,
      skipped: skippedRows.length,
      drift: rawDrift,
    },
  };
}

function categoryState(controls) {
  if (controls.length === 0) return 'internal-only';
  if (controls.some(c => c.state === 'drift')) return 'drift';
  if (controls.some(c => c.state === 'held')) return 'held';
  return 'info';
}

function summarize(categories, controls) {
  return {
    categories: {
      total: categories.length,
      docsBacked: categories.filter(c => c.officialControls.length > 0).length,
      internalOnly: categories.filter(c => c.state === 'internal-only').length,
      held: categories.filter(c => c.state === 'held').length,
      drift: categories.filter(c => c.state === 'drift').length,
      info: categories.filter(c => c.state === 'info').length,
    },
    controls: {
      total: controls.length,
      held: controls.filter(c => c.state === 'held').length,
      drift: controls.filter(c => c.state === 'drift').length,
      info: controls.filter(c => c.state === 'info').length,
      absent: controls.filter(c => !c.present).length,
    },
  };
}

function evaluateControl(control, env, settings) {
  const value = readControlValue(control, env, settings);
  const expected = control.expected ?? null;
  const adaptiveThinking = control.name === 'MAX_THINKING_TOKENS'
    && !truthy(readControlValue({ name: 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING' }, env, settings).value);
  const state = adaptiveThinking ? 'info' : (expected ? evaluateExpected(value, expected) : 'info');
  const adaptiveNote = adaptiveThinking
    ? ' Adaptive reasoning is active, so fixed MAX_THINKING_TOKENS is informational unless CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING is truthy.'
    : '';
  return {
    name: control.name,
    kind: control.kind ?? 'env',
    source: value.source,
    present: value.present,
    value: redactEnvValue(control.name, value.value),
    expected: expected ? describeExpected(expected) : null,
    state,
    doc: control.doc ?? null,
    note: `${control.note ?? ''}${adaptiveNote}`.trim(),
  };
}

function readControlValue(control, env, settings) {
  const key = control.name;
  const settingsValue = settings?.env?.[key];
  if (settingsValue !== undefined && settingsValue !== null && String(settingsValue).trim() !== '') {
    return { present: true, value: String(settingsValue), source: 'settings.env' };
  }
  if (hasOwn(env, key) && nonEmpty(env[key])) {
    return { present: true, value: String(env[key]), source: 'env' };
  }
  return { present: false, value: null, source: 'absent' };
}

function evaluateExpected(value, expected) {
  const type = expected.type;
  if (type === 'truthy') return truthy(value.value) ? 'held' : 'drift';
  if (type === 'not-truthy') return truthy(value.value) ? 'drift' : 'held';
  if (type === 'false') return explicitFalse(value.value) ? 'held' : 'drift';
  if (type === 'number-min') {
    const n = Number(value.value);
    return value.present && Number.isFinite(n) && n >= Number(expected.value) ? 'held' : 'drift';
  }
  if (type === 'exact') return String(value.value ?? '') === String(expected.value) ? 'held' : 'drift';
  return 'info';
}

function describeExpected(expected) {
  switch (expected.type) {
    case 'truthy': return 'truthy';
    case 'not-truthy': return 'not truthy';
    case 'false': return 'false';
    case 'number-min': return `>=${expected.value}`;
    case 'exact': return String(expected.value);
    default: return expected.type ?? null;
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function truthy(value) {
  if (typeof value !== 'string') return Boolean(value);
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function explicitFalse(value) {
  if (typeof value !== 'string') return false;
  return ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function redactEnvValue(key, value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (/API_KEY|AUTH_TOKEN|SECRET|PASSWORD/i.test(key)) return '[redacted]';
  return value;
}
