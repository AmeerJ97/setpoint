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

const SANDBOX = mkdtempSync(join(tmpdir(), 'setpoint-guard-status-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');

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
  // Fully held configuration: every category at its setpoint value.
  writeClaudeJson({
    cachedGrowthBookFeatures: {
      tengu_swann_brevity: '',
      tengu_sotto_voce: false,
      quiet_fern: false,
      quiet_hollow: false,
      tengu_summarize_tool_results: false,
      tengu_amber_wren: { maxTokens: 128000 },
      tengu_pewter_kestrel: { global: 500000 },
      tengu_willow_refresh_ttl_hours: 8760,
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
      tengu_pewter_kestrel: { global: 500000 },
      tengu_willow_refresh_ttl_hours: 8760,
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
  assert.ok(Number.isFinite(json.summary.held));
  assert.ok(Number.isFinite(json.summary.skipped));
  assert.ok(Number.isFinite(json.summary.drift));
  assert.equal(json.summary.held + json.summary.skipped + json.summary.drift, 17);
});

test('renderTable includes the "setpoint guard status" banner', () => {
  clearSkips();
  const rows = mod.collectGuardState();
  const out = mod.renderTable(rows).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /setpoint guard status/);
  assert.match(out, /Summary:/);
  assert.match(out, /held/);
});
