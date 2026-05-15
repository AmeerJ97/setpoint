/**
 * Behavioral hook evaluator.
 *
 * Loads every `config/hooks/*.md` file, parses its YAML frontmatter
 * (minimal parser — only supports the keys this registry uses:
 * scalar strings/numbers + a single nested `trigger` object), and
 * evaluates triggers against a metrics object supplied by the caller.
 *
 * Returns AT MOST ONE hook body per evaluation — the one with the
 * highest `priority` that:
 *   (a) has all trigger conditions satisfied
 *   (b) is not in cooldown per the state file
 *
 * Hook body contains `{placeholders}` that the evaluator substitutes
 * from the metrics object so the fired body can read like "you have
 * 7 Edits with 0 Reads" instead of generic prose.
 */

import { readFileSync, readdirSync, existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR } from '../data/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = join(__dirname, '..', '..', 'config', 'hooks');
const STATE_FILE = join(PLUGIN_DIR, 'hook-state.jsonl');
const HOOK_LOG = join(PLUGIN_DIR, 'hook-log.jsonl');

/**
 * @typedef {object} Hook
 * @property {string} name
 * @property {'reminder'|'fsm'|'adversarial'} kind
 * @property {Record<string, number|string>} trigger
 * @property {number} priority
 * @property {number} cooldownMin
 * @property {string} body
 * @property {string} path
 */

/**
 * Load all hook files from config/hooks/. Returns them sorted by
 * priority descending (highest first).
 *
 * @param {string} [dir]
 * @returns {Hook[]}
 */
export function loadHooks(dir = HOOKS_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  const hooks = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const raw = readFileSync(path, 'utf8');
      const hook = parseHook(raw);
      if (hook) hooks.push({ ...hook, path });
    } catch { /* skip unreadable */ }
  }
  hooks.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return hooks;
}

/**
 * Parse a hook Markdown file: `---` frontmatter then body.
 * Minimal YAML: scalar keys + a single nested `trigger:` block with
 * scalar children. Anything richer fails to parse and is skipped.
 *
 * @param {string} raw
 * @returns {Hook|null}
 */
export function parseHook(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return null;
  const fm = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, '');

  const out = { trigger: {}, priority: 50, cooldownMin: 15 };
  let inTrigger = false;
  for (const line of fm.split('\n')) {
    if (!line.trim()) continue;
    if (line === 'trigger:') { inTrigger = true; continue; }
    const m = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2];
    const val = m[3].trim();
    if (indent === 0) {
      inTrigger = false;
      if (val === '') { if (key === 'trigger') inTrigger = true; continue; }
      out[camel(key)] = coerce(val);
    } else if (inTrigger) {
      out.trigger[key] = coerce(val);
    }
  }

  if (!out.name || !out.kind) return null;
  return {
    name: out.name,
    kind: out.kind,
    trigger: out.trigger,
    priority: Number(out.priority ?? 50),
    cooldownMin: Number(out.cooldownMin ?? 15),
    body: body.trim(),
    path: '',
  };
}

/**
 * Check whether every trigger predicate holds for `metrics`.
 * Supported suffixes (match on key name):
 *   _above    → metrics[stem] >  threshold
 *   _below    → metrics[stem] <  threshold
 *   _min      → metrics[stem] >= threshold
 *   _max      → metrics[stem] <= threshold
 * Unknown suffix → the predicate is treated as "metrics[key] === value".
 *
 * @param {Record<string, number|string>} trigger
 * @param {Record<string, number>} metrics
 * @returns {boolean}
 */
export function triggerFires(trigger, metrics) {
  for (const [key, threshold] of Object.entries(trigger)) {
    const [stem, suffix] = splitKey(key);
    const actual = Number(metrics[stem]);
    if (!Number.isFinite(actual)) return false;
    const t = Number(threshold);
    if (!Number.isFinite(t)) {
      if (metrics[stem] !== threshold) return false;
      continue;
    }
    switch (suffix) {
      case 'above': if (!(actual >  t)) return false; break;
      case 'below': if (!(actual <  t)) return false; break;
      case 'min':   if (!(actual >= t)) return false; break;
      case 'max':   if (!(actual <= t)) return false; break;
      default:      if (actual !== t)   return false;
    }
  }
  return true;
}

/**
 * Pick the highest-priority hook whose trigger fires AND is past its
 * cooldown. Returns null when nothing qualifies.
 *
 * @param {Record<string, number>} metrics
 * @param {Hook[]} [hooks]
 * @param {number} [now=Date.now()]
 * @returns {Hook|null}
 */
export function selectHook(metrics, hooks = null, now = Date.now()) {
  const candidates = hooks ?? loadHooks();
  const state = readState();
  for (const h of candidates) {
    if (!triggerFires(h.trigger, metrics)) continue;
    const lastFired = state[h.name];
    if (lastFired && now - lastFired < h.cooldownMin * 60_000) continue;
    return h;
  }
  return null;
}

/**
 * Record that a hook fired: update cooldown state + append to audit log.
 * Side-effecting; safe to call with null.
 *
 * @param {Hook|null} hook
 * @param {Record<string, number>} metrics
 */
export function recordFire(hook, metrics) {
  if (!hook) return;
  try {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    const now = Date.now();
    const state = readState();
    state[hook.name] = now;
    appendFileSync(STATE_FILE, JSON.stringify({ ts: now, name: hook.name }) + '\n');
    appendFileSync(HOOK_LOG, JSON.stringify({
      ts: now,
      name: hook.name,
      kind: hook.kind,
      metrics,
    }) + '\n');
  } catch { /* non-critical */ }
}

/**
 * Substitute `{placeholder}` tokens in the body with values from the
 * metrics object; unknown placeholders are left intact so the user
 * sees they're unfilled.
 *
 * @param {string} body
 * @param {Record<string, number|string>} metrics
 */
export function renderBody(body, metrics) {
  return body.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, key) => {
    return metrics[key] !== undefined ? String(metrics[key]) : match;
  });
}

// ---- internals -----------------------------------------------------------

function readState() {
  // The state file is append-only; the latest entry per hook wins.
  if (!existsSync(STATE_FILE)) return {};
  try {
    const lines = readFileSync(STATE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const out = {};
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (typeof e.name === 'string' && Number.isFinite(e.ts)) out[e.name] = e.ts;
      } catch { /* corrupt line, skip */ }
    }
    return out;
  } catch {
    return {};
  }
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

function camel(s) {
  return s.replace(/[-_](\w)/g, (_, c) => c.toUpperCase());
}

function splitKey(key) {
  const idx = key.lastIndexOf('_');
  if (idx < 0) return [key, ''];
  const suffix = key.slice(idx + 1);
  if (['above', 'below', 'min', 'max'].includes(suffix)) {
    return [key.slice(0, idx), suffix];
  }
  return [key, ''];
}
