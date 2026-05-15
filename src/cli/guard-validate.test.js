import test from 'node:test';
import assert from 'node:assert/strict';
import { main, renderValidationTable } from './guard-validate.js';
import { collectGuardValidationState } from '../guard/guard-validation.js';

test('guard validate JSON is non-mutating and exits zero by default with drift', () => {
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try {
    const code = main(['validate', '--json'], {
      env: {},
      settingsPath: '/does/not/exist/settings.json',
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.posture, 'audit-first');
    assert.equal(parsed.summary.controls.drift > 0, true);
  } finally {
    process.stdout.write = orig;
  }
});

test('guard validate --strict exits non-zero when documented controls drift', () => {
  let out = '';
  const orig = process.stdout.write;
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try {
    const code = main(['validate', '--json', '--strict'], {
      env: {},
      settingsPath: '/does/not/exist/settings.json',
    });
    assert.equal(code, 1);
    assert.ok(out.length > 0);
  } finally {
    process.stdout.write = orig;
  }
});

test('guard validate human output includes posture and official/internal summary', () => {
  const state = collectGuardValidationState({
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
  }, { settingsPath: '/does/not/exist/settings.json' });
  const out = renderValidationTable(state).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(out, /claude-ops guard validate/);
  assert.match(out, /posture: audit-first/);
  assert.match(out, /official/);
  assert.match(out, /internal-only/);
});
