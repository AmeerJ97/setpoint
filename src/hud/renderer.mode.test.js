import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CLI = join(REPO, 'src', 'cli', 'index.js');
const SUBSCRIPTION_FIXTURE = join(REPO, 'tests', 'fixtures', 'statusline', 'subscription.json');
const API_FIXTURE = join(REPO, 'tests', 'fixtures', 'statusline', 'api-billing.json');

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-render-mode-'));
  mkdirSync(join(sandbox, '.claude'), { recursive: true });
  writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({}));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function renderFixture(path, extraEnv = {}) {
  const input = readFileSync(path, 'utf8');
  const r = spawnSync('node', [CLI], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      CLAUDE_CONFIG_DIR: join(sandbox, '.claude'),
      CLAUDE_OPS_CLAUDE_JSON_PATH: join(sandbox, '.claude.json'),
      CLAUDE_OPS_SKIP_SYSTEMCTL: '1',
    },
  });
  if (r.error?.code === 'EPERM') return null;
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

test('subscription statusLine fixture renders quota windows', t => {
  const out = renderFixture(SUBSCRIPTION_FIXTURE);
  if (out === null) return t.skip('nested node spawn is blocked in this sandbox');
  assert.match(out, /Us(e|age)\s+.*5h/);
  assert.match(out, /7d/);
  assert.match(out, /Model\s+.*\[ANTHROPIC-PRO\]/);
  assert.equal(countMatches(out, /\[ANTHROPIC-PRO\]/g), 1);
  assert.doesNotMatch(out, /Usage \[ANTHROPIC-API\]/);
});

test('API billing statusLine fixture renders cost-metered usage', t => {
  const out = renderFixture(API_FIXTURE, { ANTHROPIC_API_KEY: 'sk-ant-test-secret' });
  if (out === null) return t.skip('nested node spawn is blocked in this sandbox');
  assert.match(out, /Model\s+.*\[ANTHROPIC-API\]/);
  assert.equal(countMatches(out, /\[ANTHROPIC-API\]/g), 1);
  assert.match(out, /Us(e|age)\s+/);
  assert.match(out, /\(5h\)|5h:/);
  assert.match(out, /7d:(warming|cooling|steady|no history yet)|\s7d:/);
  assert.doesNotMatch(out, /5h:--%/);
  assert.doesNotMatch(out, /sk-ant-test-secret/);
});

test('Vertex statusLine fixture renders fail-closed API-missing usage when snapshot is absent', t => {
  const out = renderFixture(API_FIXTURE, {
    CLAUDE_CODE_USE_VERTEX: '1',
    CLOUD_ML_REGION: 'us-east5',
    ANTHROPIC_VERTEX_PROJECT_ID: 'test-project',
  });
  if (out === null) return t.skip('nested node spawn is blocked in this sandbox');
  assert.match(out, /Model\s+.*\[VERTEX-AI\]/);
  assert.equal(countMatches(out, /\[VERTEX-AI\]/g), 1);
  assert.match(out, /Us(e|age)\s+telem:miss missing/);
  assert.match(out, /billing:missing|5h:--/);
  assert.doesNotMatch(out, /5h:--%/);
});
