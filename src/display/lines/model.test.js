import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderModelLine } from './model.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

test('Model line uses live statusLine effort over persisted settings fallback', () => {
  const line = strip(renderModelLine({
    narrow: false,
    stdin: {
      model: { display_name: 'Opus 4.7', id: 'claude-opus-4-7' },
      cwd: '/tmp/project',
    },
    effort: 'xhigh',
    authProvider: 'subscription',
    billingSignal: 'quota-window',
    runtimeMode: {
      authProvider: 'subscription',
      billingSignal: 'quota-window',
      backend: 'anthropic-pro',
    },
    gitStatus: null,
    sessionDuration: '1m',
  }));

  assert.match(line, /\[ANTHROPIC-PRO\] \[Opus 4\.7 xhigh\]/);
});
