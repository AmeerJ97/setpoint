import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, repairGuardControls } from './guard-repair.js';
import { collectGuardValidationState } from '../guard/guard-validation.js';

const SANDBOXES = [];

afterEach(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('guard repair dry-run reports repairable drift without writing settings', () => {
  const s = sandbox();
  const result = repairGuardControls({ apply: false, env: {}, settingsPath: s.settingsPath });

  assert.equal(result.applied, false);
  assert.equal(result.summary.repairable, 5);
  assert.equal(existsSync(s.settingsPath), false);
});

test('guard repair apply writes docs-backed defaults and clears strict drift', () => {
  const s = sandbox();
  writeFileSync(s.settingsPath, JSON.stringify({ statusLine: { command: 'node /tmp/cli.js' } }));

  const result = repairGuardControls({ apply: true, env: {}, settingsPath: s.settingsPath });
  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  const after = collectGuardValidationState({}, { settingsPath: s.settingsPath });

  assert.equal(result.ok, true);
  assert.equal(settings.statusLine.command, 'node /tmp/cli.js');
  assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '128000');
  assert.equal(settings.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS, '500000');
  assert.equal(settings.env.MAX_MCP_OUTPUT_TOKENS, '500000');
  assert.equal(settings.env.ENABLE_PROMPT_CACHING_1H, '1');
  assert.equal(settings.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  assert.equal(after.summary.controls.drift, 0);
});

test('guard repair preserves unrelated settings env and writes backups before mutation', () => {
  const s = sandbox();
  writeFileSync(s.settingsPath, JSON.stringify({
    env: { KEEP_ME: '1' },
  }));

  repairGuardControls({ apply: true, env: {}, settingsPath: s.settingsPath });

  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  assert.equal(settings.env.KEEP_ME, '1');
  assert.ok(safeListDir(s.settingsDir).some(name => name.startsWith('settings.json.bak.')));
});

test('guard repair can clear env-sourced drift by writing persistent settings env', () => {
  const s = sandbox();
  const result = repairGuardControls({
    apply: true,
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000' },
    settingsPath: s.settingsPath,
  });

  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.operations.find(op => op.name === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS')?.status, 'repairable');
  assert.equal(settings.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '128000');
});

test('guard repair CLI exits zero when env-sourced drift is repaired through settings env', () => {
  const s = sandbox();
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = chunk => { output += String(chunk); return true; };
  try {
    const code = main(['repair', '--apply', '--json'], {
      env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1000' },
      settingsPath: s.settingsPath,
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(output).ok, true);
  } finally {
    process.stdout.write = original;
  }
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-guard-repair-'));
  SANDBOXES.push(dir);
  const settingsDir = join(dir, '.claude');
  mkdirSync(settingsDir, { recursive: true });
  return { dir, settingsDir, settingsPath: join(settingsDir, 'settings.json') };
}

function safeListDir(dir) {
  try { return readdirSync(dir); }
  catch { return []; }
}
