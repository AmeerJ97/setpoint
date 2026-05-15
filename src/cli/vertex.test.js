import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, statusResult } from './vertex.js';

const SANDBOXES = [];
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('vertex status reports cache policy and active alias', () => {
  const s = sandbox({
    model: 'haiku',
    env: {
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'vierla-prod',
      CLOUD_ML_REGION: 'global',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5@20251001',
    },
  });
  const result = statusResult(s.settings, {}, s.settingsPath);
  assert.equal(result.vertex.state, 'held');
  assert.equal(result.cache.mode, '5m');
  assert.equal(result.activeAlias, 'haiku');
});

test('vertex cache 1h updates settings env', async () => {
  const s = sandbox({
    model: 'haiku',
    env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5@20251001' },
  });
  const code = await main(['cache', '1h', '--json'], { settingsPath: s.settingsPath, env: {} });
  assert.equal(code, 0);
  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  assert.equal(settings.env.ENABLE_PROMPT_CACHING_1H, '1');
});

test('vertex switch changes active alias and hydrates defaults', async () => {
  const s = sandbox({});
  const code = await main(['switch', 'sonnet', '--json'], { settingsPath: s.settingsPath, env: {} });
  assert.equal(code, 0);
  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  assert.equal(settings.model, 'sonnet');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'claude-sonnet-4-6[1m]');
});

test('vertex use writes project, region, and active model', async () => {
  const s = sandbox({});
  const code = await main([
    'use',
    '--project', 'vierla-prod',
    '--region', 'global',
    '--active', 'haiku',
    '--cache', '1h',
    '--json',
  ], { settingsPath: s.settingsPath, env: {} });
  assert.equal(code, 0);
  const settings = JSON.parse(readFileSync(s.settingsPath, 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(settings.env.ANTHROPIC_VERTEX_PROJECT_ID, 'vierla-prod');
  assert.equal(settings.env.CLOUD_ML_REGION, 'global');
  assert.equal(settings.model, 'haiku');
  assert.equal(settings.env.ENABLE_PROMPT_CACHING_1H, '1');
});

function sandbox(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-cli-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const settingsPath = join(claudeDir, 'settings.json');
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { dir, claudeDir, settingsPath, settings };
}
