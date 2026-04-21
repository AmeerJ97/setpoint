/**
 * `setpoint guard status` — drilldown view of the guard's enforcement
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
 *   • Recent activations   → /tmp/claude-quality-guard.log
 *   • Current held values  → ~/.claude.json cachedGrowthBookFeatures
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR, CLAUDE_JSON_PATH, GUARD_LOG_FILE } from '../data/paths.js';
import { loadDefaults } from '../data/defaults.js';

// Flag-target map mirroring src/guard/claude-quality-guard.sh apply_overrides().
// Keep this in sync when adding categories to the bash guard.
const CATEGORY_TARGETS = {
  brevity:      [{ path: ['cachedGrowthBookFeatures', 'tengu_swann_brevity'], target: '' }],
  quiet:        [
    { path: ['cachedGrowthBookFeatures', 'tengu_sotto_voce'], target: false },
    { path: ['cachedGrowthBookFeatures', 'quiet_fern'],       target: false },
    { path: ['cachedGrowthBookFeatures', 'quiet_hollow'],     target: false },
  ],
  summarize:    [{ path: ['cachedGrowthBookFeatures', 'tengu_summarize_tool_results'], target: false }],
  maxtokens:    [{ path: ['cachedGrowthBookFeatures', 'tengu_amber_wren', 'maxTokens'], target: 128000 }],
  truncation:   [{ path: ['cachedGrowthBookFeatures', 'tengu_pewter_kestrel', 'global'], target: 500000 }],
  refresh_ttl:  [{ path: ['cachedGrowthBookFeatures', 'tengu_willow_refresh_ttl_hours'], target: 8760 }],
  mcp_connect:  [{ path: ['cachedGrowthBookFeatures', 'tengu_claudeai_mcp_connectors'], target: false }],
  bridge:       [{ path: ['bridge', 'enabled'], target: false }],
  grey_step:    [{ path: ['cachedGrowthBookFeatures', 'tengu_grey_step'], target: false }],
  grey_step2:   [{ path: ['cachedGrowthBookFeatures', 'tengu_grey_step2', 'enabled'], target: false }],
  grey_wool:    [{ path: ['cachedGrowthBookFeatures', 'tengu_grey_wool'], target: false }],
  thinking:     [{ path: ['cachedGrowthBookFeatures', 'tengu_crystal_beam', 'budgetTokens'], target: 128000 }],
  willow_mode:  [{ path: ['cachedGrowthBookFeatures', 'tengu_willow_mode'], target: '' }],
  compact_max:  [{ path: ['cachedGrowthBookFeatures', 'tengu_sm_compact_config', 'maxTokens'], target: 200000 }],
  compact_init: [{ path: ['cachedGrowthBookFeatures', 'tengu_sm_config', 'minimumMessageTokensToInit'], target: 500000 }],
  tool_persist: [{ path: ['cachedGrowthBookFeatures', 'tengu_tool_result_persistence'], target: true }],
  chomp:        [{ path: ['cachedGrowthBookFeatures', 'tengu_chomp_inflection'], target: true }],
};

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
    out.push({
      category: cat,
      state,
      flags,
      lastSeen: seen?.ts ?? null,
      lastFlag: seen?.flag ?? null,
      description: descriptions[cat] ?? '',
      skipReason: state === 'skipped' ? (skipReasons.get(cat) ?? null) : null,
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

const STATE_COLOR = { held: GREEN, drift: RED, skipped: YELLOW };

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
  const lines = [];
  lines.push(`${BOLD}setpoint guard status${RESET}`);
  lines.push('');
  lines.push(`${BOLD}STATE     CATEGORY        LAST EVENT       DESCRIPTION${RESET}`);
  for (const row of rows) {
    const color = STATE_COLOR[row.state] ?? RESET;
    const stateCell = `${color}${row.state.padEnd(8)}${RESET}`;
    const cat = row.category.padEnd(14);
    const age = row.lastSeen ? `${row.lastFlag ?? ''} ${formatAge(row.lastSeen)}` : '—';
    const ageCell = age.padEnd(16);
    // When a category is skipped with a reason, render the reason inline in
    // the description column so the drilldown answers "why is this skipped?"
    // without the operator opening a sibling file.
    const desc = row.state === 'skipped' && row.skipReason
      ? `${row.description}${row.description ? ' ' : ''}${DIM}[${row.skipReason}]${RESET}`
      : row.description;
    lines.push(`${stateCell}  ${cat}  ${DIM}${ageCell}${RESET}  ${desc}`);

    for (const f of row.flags) {
      const diff = row.state === 'drift' && !deepEquals(f.actual, f.expected);
      const flagColor = diff ? RED : DIM;
      const detail = `    ${DIM}↳ ${f.flag}${RESET} = ${flagColor}${formatValue(f.actual)}${RESET}${diff ? ` ${DIM}(want ${formatValue(f.expected)})${RESET}` : ''}`;
      lines.push(detail);
    }
  }
  lines.push('');
  const held = rows.filter(r => r.state === 'held').length;
  const skipped = rows.filter(r => r.state === 'skipped').length;
  const drift = rows.filter(r => r.state === 'drift').length;
  lines.push(`${BOLD}Summary:${RESET} ${GREEN}${held} held${RESET}, ${YELLOW}${skipped} skipped${RESET}, ${drift > 0 ? RED : DIM}${drift} drifted${RESET}`);
  return lines.join('\n');
}

export function renderJson(rows) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: {
      total: rows.length,
      held: rows.filter(r => r.state === 'held').length,
      skipped: rows.filter(r => r.state === 'skipped').length,
      drift: rows.filter(r => r.state === 'drift').length,
    },
    categories: rows,
  }, null, 2);
}

export function main(argv = process.argv.slice(2)) {
  const rows = collectGuardState();
  const json = argv.includes('--json');
  process.stdout.write(json ? renderJson(rows) + '\n' : renderTable(rows) + '\n');
  // Exit non-zero if anything is drifting — useful in CI.
  const hasDrift = rows.some(r => r.state === 'drift');
  return hasDrift ? 1 : 0;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main());
}
