import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAnalyticsResult } from './analytics.js';

test('renderAnalyticsResult explains on-demand analytics behavior', () => {
  const text = renderAnalyticsResult({
    installed: true,
    unitPath: '/tmp/systemd/claude-ops-analytics.service',
    active: 'inactive',
    enabled: 'disabled',
    mode: 'on-demand',
    pathCurrent: true,
    behavior: 'Claude Code statusLine starts this service; it exits after idle time.',
    environment: ['CLAUDE_OPS_ANALYTICS_POLL_MS=30000'],
  });

  assert.match(text, /stopped \(on-demand, not enabled at login\)/);
  assert.match(text, /Claude Code statusLine starts this service/);
  assert.match(text, /claude-ops analytics start \| stop \| restart/);
});
