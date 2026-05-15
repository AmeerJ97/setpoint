/*
 * guard-status drilldown — unit tests for state classification and
 * output shapes. Sandboxes $CLAUDE_CONFIG_DIR so the tests build their
 * own ~/.claude.json + guard-config skip files deterministically.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'claude-ops-guard-status-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');
process.env.CLAUDE_OPS_CLAUDE_JSON_PATH = join(SANDBOX, '.claude.json');

const paths = await import('../data/paths.js');
const mod = await import('./guard-status.js');

function writeClaudeJson(obj) {
  mkdirSync(SANDBOX, { recursive: true });
  writeFileSync(paths.CLAUDE_JSON_PATH, JSON.stringify(obj));
}
function markSkipped(category) {
  const dir = join(paths.PLUGIN_DIR, 'guard-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${category}.skip`), '');
}
function clearSkips() {
  rmSync(join(paths.PLUGIN_DIR, 'guard-config'), { recursive: true, force: true });
}

before(() => {
  // Fully held configuration: every category at its claude-ops value.
  writeClaudeJson({
    cachedGrowthBookFeatures: {
      tengu_swann_brevity: '',
      tengu_sotto_voce: false,
      quiet_fern: false,
      quiet_hollow: false,
      tengu_summarize_tool_results: false,
      tengu_amber_wren: { maxTokens: 128000 },
      tengu_pewter_kestrel: {
        global: 500000,
        Bash: 500000,
        PowerShell: 500000,
        Grep: 500000,
        Snip: 500000,
        StrReplaceBasedEditTool: 500000,
        BashSearchTool: 500000,
      },
      tengu_willow_refresh_ttl_hours: 8760,
      tengu_willow_census_ttl_hours: 8760,
      tengu_claudeai_mcp_connectors: false,
      tengu_grey_step: false,
      tengu_grey_step2: { enabled: false },
      tengu_grey_wool: false,
      tengu_crystal_beam: { budgetTokens: 128000 },
      tengu_willow_mode: '',
      tengu_sm_compact_config: { maxTokens: 200000 },
      tengu_sm_config: { minimumMessageTokensToInit: 500000 },
      tengu_tool_result_persistence: true,
      tengu_chomp_inflection: true,
    },
    bridge: { enabled: false },
  });
});
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('all-held config returns held for every category', () => {
  clearSkips();
  const rows = mod.collectGuardState();
  assert.equal(rows.length, 17, '17 categories exactly');
  const nonHeld = rows.filter(r => r.state !== 'held');
  assert.equal(nonHeld.length, 0, `every category held, got drifts: ${nonHeld.map(r => r.category).join(', ')}`);
  const maxtokens = rows.find(r => r.category === 'maxtokens');
  assert.equal(maxtokens.authority, 'hybrid');
  assert.deepEqual(maxtokens.officialControls, ['CLAUDE_CODE_MAX_OUTPUT_TOKENS']);
});

test('deleted field flips category to drift', () => {
  clearSkips();
  // Break just one category.
  writeClaudeJson({
    cachedGrowthBookFeatures: {
      tengu_swann_brevity: 'focused', // was ''
      tengu_sotto_voce: false, quiet_fern: false, quiet_hollow: false,
      tengu_summarize_tool_results: false,
      tengu_amber_wren: { maxTokens: 128000 },
      tengu_pewter_kestrel: {
        global: 500000,
        Bash: 500000,
        PowerShell: 500000,
        Grep: 500000,
        Snip: 500000,
        StrReplaceBasedEditTool: 500000,
        BashSearchTool: 500000,
      },
      tengu_willow_refresh_ttl_hours: 8760,
      tengu_willow_census_ttl_hours: 8760,
      tengu_claudeai_mcp_connectors: false,
      tengu_grey_step: false,
      tengu_grey_step2: { enabled: false },
      tengu_grey_wool: false,
      tengu_crystal_beam: { budgetTokens: 128000 },
      tengu_willow_mode: '',
      tengu_sm_compact_config: { maxTokens: 200000 },
      tengu_sm_config: { minimumMessageTokensToInit: 500000 },
      tengu_tool_result_persistence: true,
      tengu_chomp_inflection: true,
    },
    bridge: { enabled: false },
  });
  const rows = mod.collectGuardState();
  const brevity = rows.find(r => r.category === 'brevity');
  assert.equal(brevity.state, 'drift');
  const others = rows.filter(r => r.category !== 'brevity');
  assert.ok(others.every(r => r.state === 'held'),
    `only brevity should drift; drifted: ${others.filter(r => r.state !== 'held').map(r => r.category).join(', ')}`);
});

test('skip file flips category to skipped regardless of actual value', () => {
  clearSkips();
  markSkipped('brevity');
  // Put a drift value; skipped should still win.
  writeClaudeJson({
    cachedGrowthBookFeatures: { tengu_swann_brevity: 'whatever' },
  });
  const rows = mod.collectGuardState();
  const brevity = rows.find(r => r.category === 'brevity');
  assert.equal(brevity.state, 'skipped');
});

test('renderJson includes summary counts and category array', () => {
  clearSkips();
  const rows = mod.collectGuardState();
  const json = JSON.parse(mod.renderJson(rows));
  assert.equal(json.summary.total, 17);
  assert.equal(json.categories.length, 17);
  assert.ok(Number.isFinite(json.summary.raw.held));
  assert.ok(Number.isFinite(json.summary.raw.skipped));
  assert.ok(Number.isFinite(json.summary.raw.drift));
  assert.equal(json.summary.raw.held + json.summary.raw.skipped + json.summary.raw.drift, 17);
  assert.ok(Number.isFinite(json.summary.official.controls.drift));
  assert.ok(Number.isFinite(json.summary.internal.total));
});

test('renderTable includes the "claude-ops guard status" banner', () => {
  clearSkips();
  const rows = mod.collectGuardState();
  const out = mod.renderTable(rows).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /claude-ops guard status/);
  assert.match(out, /Summary:/);
  assert.match(out, /official held/);
  assert.match(out, /Internal GrowthBook probes/);
});

test('CATEGORY_TARGETS mirrors Rust multi-key truncation and refresh TTL surface', () => {
  assert.equal(Object.keys(mod.CATEGORY_TARGETS).length, 17);
  assert.deepEqual(
    mod.CATEGORY_TARGETS.truncation.map(t => t.path.join('.')),
    [
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.global',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.Bash',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.PowerShell',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.Grep',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.Snip',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.StrReplaceBasedEditTool',
      'cachedGrowthBookFeatures.tengu_pewter_kestrel.BashSearchTool',
    ],
  );
  assert.deepEqual(
    mod.CATEGORY_TARGETS.refresh_ttl.map(t => t.path.join('.')),
    [
      'cachedGrowthBookFeatures.tengu_willow_refresh_ttl_hours',
      'cachedGrowthBookFeatures.tengu_willow_census_ttl_hours',
    ],
  );
});
