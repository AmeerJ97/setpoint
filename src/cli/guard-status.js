/**
 * `claude-ops guard status` — drilldown view of the guard's enforcement
 * surface. Follows the chezmoi `status`/`doctor` split: the statusLine
 * stays narrow, this subcommand answers "what exactly is being
 * enforced right now?" in full detail.
 *
 * Two modes:
 *   - default: three-column ANSI table (STATE / CATEGORY / DETAIL)
 *   - --json:  machine-readable blob suitable for piping to jq
 *
 * Sources of truth:
 *   • Category registry    → config/defaults.json guard.categories
 *   • Skipped categories   → $PLUGIN_DIR/guard-config/<cat>.skip
 *   • Recent activations   → $PLUGIN_DIR/guard.log
 *   • Current held values  → ~/.claude.json cachedGrowthBookFeatures
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_DIR, CLAUDE_JSON_PATH, GUARD_LOG_FILE } from '../data/paths.js';
import { loadDefaults } from '../data/defaults.js';
import { collectVertexConfigState } from '../guard/vertex-config.js';
import { guardControlMeta } from '../guard/guard-manifest.js';
import { buildGuardPresentationSummary, collectGuardValidationState } from '../guard/guard-validation.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const GUARD_TARGETS_FILE = resolve(MODULE_DIR, '..', '..', 'config', 'guard-targets.json');

// Canonical status target map. Rust enforcement has a parity test against
// this file so the status view cannot silently diverge from the guard.
export const CATEGORY_TARGETS = JSON.parse(readFileSync(GUARD_TARGETS_FILE, 'utf8'));

function getAtPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function readClaudeJson() {
  try {
    if (!existsSync(CLAUDE_JSON_PATH)) return {};
    return JSON.parse(readFileSync(CLAUDE_JSON_PATH, 'utf8'));
  } catch { return {}; }
}

function readSkippedCategories() {
  const dir = join(PLUGIN_DIR, 'guard-config');
  try {
    if (!existsSync(dir)) return new Set();
    return new Set(
      readdirSync(dir)
        .filter(f => f.endsWith('.skip'))
        .map(f => f.slice(0, -'.skip'.length)),
    );
  } catch { return new Set(); }
}

/**
 * Read the optional `<cat>.skip.reason` sibling tag for each skipped
 * category. Returned as a Map so skip-reasons are self-documenting on the
 * drilldown instead of every skip looking the same.
 * @param {Iterable<string>} cats
 * @returns {Map<string, string>}
 */
function readSkipReasons(cats) {
  const dir = join(PLUGIN_DIR, 'guard-config');
  const out = new Map();
  for (const cat of cats) {
    try {
      const p = join(dir, `${cat}.skip.reason`);
      if (!existsSync(p)) continue;
      const txt = readFileSync(p, 'utf8').split('\n')[0].trim();
      if (txt) out.set(cat, txt);
    } catch { /* ignore */ }
  }
  return out;
}

function parseGuardLogForCategoryLastSeen() {
  // Map category → { flag, ts } for the most recent re-application
  // touching any flag in that category.
  const flagToCategory = {};
  for (const [cat, targets] of Object.entries(CATEGORY_TARGETS)) {
    for (const t of targets) {
      const leafFlag = t.path[t.path.length - 2] === 'cachedGrowthBookFeatures'
        ? t.path[t.path.length - 1]
        : t.path.join('.');
      flagToCategory[leafFlag] = cat;
    }
  }

  const byCategory = {};
  if (!existsSync(GUARD_LOG_FILE)) return byCategory;
  try {
    for (const line of readFileSync(GUARD_LOG_FILE, 'utf8').split('\n')) {
      if (!line.includes('Re-applied')) continue;
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/);
      const flagsMatch = line.match(/Re-applied:\s+([^()]+?)\s+\(\d+ overrides\)/);
      if (!tsMatch || !flagsMatch) continue;
      const ts = new Date(tsMatch[1]);
      if (Number.isNaN(ts.getTime())) continue;
      for (const raw of flagsMatch[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const cat = flagToCategory[raw] ?? flagToCategory[raw.split('.')[0]];
        if (!cat) continue;
        const prev = byCategory[cat];
        if (!prev || ts.getTime() > prev.ts.getTime()) {
          byCategory[cat] = { flag: raw, ts };
        }
      }
    }
  } catch { /* ignore */ }
  return byCategory;
}

/**
 * Compute the authoritative state per category.
 * @returns {Array<{ category: string, state: 'held'|'drift'|'skipped', flags: Array<{ flag: string, expected: any, actual: any }>, lastSeen: Date|null, lastFlag: string|null, description: string }>}
 */
export function collectGuardState() {
  const defaults = loadDefaults();
  const descriptions = defaults.guard?.categories ?? {};
  const claudeJson = readClaudeJson();
  const skipped = readSkippedCategories();
  const skipReasons = readSkipReasons(skipped);
  const lastSeen = parseGuardLogForCategoryLastSeen();

  const out = [];
  const names = Object.keys(CATEGORY_TARGETS).sort();
  for (const cat of names) {
    const targets = CATEGORY_TARGETS[cat];
    const flags = targets.map(t => ({
      flag: t.path.slice(-1)[0] === 'enabled' || t.path.slice(-1)[0] === 'maxTokens' || t.path.slice(-1)[0] === 'global' || t.path.slice(-1)[0] === 'budgetTokens' || t.path.slice(-1)[0] === 'minimumMessageTokensToInit'
        ? t.path.slice(-2).join('.')
        : t.path.slice(-1)[0],
      expected: t.target,
      actual: getAtPath(claudeJson, t.path),
    }));

    let state;
    if (skipped.has(cat)) state = 'skipped';
    else if (flags.every(f => f.actual === f.expected || deepEquals(f.actual, f.expected))) state = 'held';
    else state = 'drift';

    const seen = lastSeen[cat] ?? null;
    const meta = guardControlMeta(cat) ?? {};
    const officialControls = (meta.officialControls ?? []).map(control => control.name);
    const authority = meta.authority ?? 'internal-growthbook';
    out.push({
      category: cat,
      state,
      flags,
      lastSeen: seen?.ts ?? null,
      lastFlag: seen?.flag ?? null,
      description: descriptions[cat] ?? '',
      skipReason: state === 'skipped' ? (skipReasons.get(cat) ?? null) : null,
      authority,
      tier: officialControls.length > 0 ? authority : 'internal-experimental',
      enforcement: meta.enforcement ?? 'internal-opt-in',
      risk: meta.risk ?? null,
      officialControls,
    });
  }
  return out;
}

function deepEquals(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEquals(a[k], b[k]));
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Renderers                                                                  */
/* -------------------------------------------------------------------------- */

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

const STATE_COLOR = {
  held: GREEN,
  drift: RED,
  skipped: YELLOW,
  probe: YELLOW,
  info: DIM,
  'internal-only': YELLOW,
  disabled: YELLOW,
};

function formatAge(date) {
  if (!date) return '—';
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatValue(v) {
  if (v === undefined) return '(unset)';
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v}"`;
  return String(v);
}

/**
 * Render the table view. Returns a string; caller writes to stdout.
 */
export function renderTable(rows) {
  const vertexConfig = rows.vertexConfig ?? collectVertexConfigState();
  const categories = Array.isArray(rows) ? rows : rows.categories;
  const validation = rows.validation ?? collectGuardValidationState();
  const summary = rows.summary ?? buildGuardPresentationSummary(categories, validation);
  const lines = [];
  lines.push(`${BOLD}claude-ops guard status${RESET}`);
  lines.push('');
  lines.push(`${BOLD}Summary:${RESET} `
    + `${summary.official.controls.drift > 0 ? RED : GREEN}${summary.official.controls.drift} official drift${RESET}, `
    + `${GREEN}${summary.official.controls.held} official held${RESET}, `
    + `${YELLOW}${summary.internal.total} internal probes${RESET}, `
    + `${YELLOW}${summary.skipped.total} skipped${RESET}`);
  lines.push('');

  lines.push(`${BOLD}Official controls${RESET}`);
  lines.push(`${BOLD}STATE     CATEGORY        AUTHORITY              CONTROL${RESET}`);
  for (const cat of validation.categories.filter(c => c.officialControls.length > 0)) {
    const skipped = categories.find(r => r.category === cat.category && r.state === 'skipped');
    const state = skipped ? 'skipped' : cat.state;
    const color = STATE_COLOR[state] ?? RESET;
    const reason = skipped?.skipReason ? ` ${DIM}[${skipped.skipReason}]${RESET}` : '';
    lines.push(`${color}${state.padEnd(8)}${RESET}  ${cat.category.padEnd(14)}  ${cat.authority.padEnd(21)}  ${cat.claim}${reason}`);
    for (const control of cat.officialControls) {
      const cColor = STATE_COLOR[control.state] ?? RESET;
      const source = control.present ? `${control.source}=${formatValue(control.value)}` : 'absent';
      const expected = control.expected ? ` want ${control.expected}` : ' info';
      lines.push(`    ${cColor}${control.state.padEnd(8)}${RESET} ${control.name} ${DIM}${source};${expected}${RESET}`);
    }
  }

  lines.push('');
  lines.push(`${BOLD}Internal GrowthBook probes${RESET} ${DIM}(not primary guard failures)${RESET}`);
  lines.push(`${BOLD}STATE     CATEGORY        LAST EVENT       DESCRIPTION${RESET}`);
  for (const row of categories.filter(r => (r.officialControls ?? []).length === 0)) {
    const state = row.state === 'drift' ? 'probe' : row.state;
    const color = STATE_COLOR[state] ?? RESET;
    const stateCell = `${color}${state.padEnd(8)}${RESET}`;
    const cat = row.category.padEnd(14);
    const age = row.lastSeen ? `${row.lastFlag ?? ''} ${formatAge(row.lastSeen)}` : '—';
    const ageCell = age.padEnd(16);
    const desc = row.state === 'skipped' && row.skipReason
      ? `${row.description}${row.description ? ' ' : ''}${DIM}[${row.skipReason}]${RESET}`
      : row.description;
    lines.push(`${stateCell}  ${cat}  ${DIM}${ageCell}${RESET}  ${desc}`);

    for (const f of row.flags) {
      const diff = row.state === 'drift' && !deepEquals(f.actual, f.expected);
      const flagColor = diff ? YELLOW : DIM;
      const detail = `    ${DIM}↳ ${f.flag}${RESET} = ${flagColor}${formatValue(f.actual)}${RESET}${diff ? ` ${DIM}(probe target ${formatValue(f.expected)})${RESET}` : ''}`;
      lines.push(detail);
    }
  }

  lines.push('');
  if (vertexConfig.configured || vertexConfig.active) {
    const color = vertexConfig.state === 'held' ? GREEN : YELLOW;
    lines.push(`${color}${vertexConfig.state.padEnd(8)}${RESET}  ${'vertex_env'.padEnd(14)}  ${DIM}${'audit-only'.padEnd(16)}${RESET}  ${vertexConfig.detail}`);
  }
  return lines.join('\n');
}

export function renderJson(rows) {
  const vertexConfig = rows.vertexConfig ?? collectVertexConfigState();
  const categories = Array.isArray(rows) ? rows : rows.categories;
  const validation = rows.validation ?? collectGuardValidationState();
  const summary = rows.summary ?? buildGuardPresentationSummary(categories, validation);
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary,
    categories,
    validation,
    vertexConfig,
  }, null, 2);
}

export function main(argv = process.argv.slice(2)) {
  const rows = collectGuardState();
  const validation = collectGuardValidationState();
  const summary = buildGuardPresentationSummary(rows, validation);
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const payload = { categories: rows, validation, summary };
  process.stdout.write(json ? renderJson(payload) + '\n' : renderTable(payload) + '\n');
  const officialDrift = summary.official.controls.drift > 0;
  return strict && officialDrift ? 1 : 0;
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main());
}
