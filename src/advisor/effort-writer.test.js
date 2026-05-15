import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'claude-ops-effort-writer-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');
process.env.CLAUDE_OPS_CLAUDE_JSON_PATH = join(SANDBOX, '.claude.json');
process.env.CLAUDE_OPS_AUTO_EFFORT = '1';
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const mod = await import('./effort-writer.js');

after(() => {
  delete process.env.CLAUDE_OPS_AUTO_EFFORT;
  rmSync(SANDBOX, { recursive: true, force: true });
});

test('applySwap refuses to persist max because it is session-only', () => {
  const result = mod.applySwap({
    target: 'max',
    reason: 'test',
    contextPct: 10,
    current: 'xhigh',
  });

  assert.equal(result.applied, false);
  assert.match(result.reason, /session-only/);
  assert.equal(existsSync(join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')), false);
});
