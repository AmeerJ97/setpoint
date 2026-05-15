import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render } from './renderer.js';
import { setColorMode } from './colors.js';
import { resetGlyphCache } from './glyphs.js';

afterEach(() => {
  delete process.env.CLAUDE_OPS_PLAIN;
  setColorMode(null);
  resetGlyphCache();
});

test('render emits no ANSI escapes in color mode none', () => {
  setColorMode('none', 'cividis');
  const lines = captureRender(sampleCtx());
  assert.ok(lines.length >= 8);
  assert.doesNotMatch(lines.join('\n'), /\x1b\[[0-9;]*m/);
});

test('render emits ASCII-only HUD when CLAUDE_OPS_PLAIN is set', () => {
  process.env.CLAUDE_OPS_PLAIN = '1';
  setColorMode('none', 'cividis');
  resetGlyphCache();
  const output = captureRender(sampleCtx()).join('\n');
  assert.doesNotMatch(output, /\x1b\[[0-9;]*m/);
  assert.doesNotMatch(output, /[^\x09\x0a\x0d\x20-\x7e]/);
  assert.match(output, /62->78/);
});

function captureRender(ctx) {
  const original = console.log;
  const lines = [];
  console.log = line => lines.push(String(line));
  try {
    render(ctx);
  } finally {
    console.log = original;
  }
  return lines;
}

function sampleCtx() {
  return {
    stdin: {
      session_id: 'render-test',
      model: { display_name: 'Opus 4.7', id: 'claude-opus-4-7' },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 48,
        current_usage: {
          input_tokens: 42_000,
          output_tokens: 9_500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 30_000,
        },
      },
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: null },
        seven_day: { used_percentage: 38, resets_at: null },
      },
      cwd: '/tmp/render-test',
    },
    usageData: { fiveHour: 62, sevenDay: 38, fiveHourResetAt: null, sevenDayResetAt: null },
    mode: 'max',
    authProvider: 'subscription',
    billingSignal: 'quota-window',
    runtimeMode: {
      mode: 'max',
      authProvider: 'subscription',
      billingSignal: 'quota-window',
      backend: 'anthropic-pro',
      telemetryAuthority: 'server-rate-limits',
    },
    gitStatus: { branch: 'main', isDirty: false, ahead: 0, behind: 0 },
    sessionDuration: '23m',
    claudeMdCount: 2,
    rulesCount: 13,
    mcpCount: 12,
    hooksCount: 7,
    activeMcps: ['brave', 'perplexity', 'sentry'],
    effort: 'xhigh',
    isCompressed: false,
    tokenStats: {
      totalInput: 42_000,
      totalOutput: 9_500,
      totalCacheCreate: 0,
      totalCacheRead: 30_000,
      apiCalls: 18,
      burnRate: 211,
      durationMin: 23,
    },
    guardStatus: {
      running: true,
      activationsToday: 4,
      activationsLastHour: 2,
      lastActivation: new Date(Date.now() - 2 * 60_000),
      lastFlag: 'brevity',
      skippedCount: 0,
    },
    advisory: {
      signal: 'increase',
      reason: '38% weekly remaining',
      fiveHour: { current: 62, projected: 0.78, level: 'tight' },
      sevenDay: { current: 38, projected: 0.52, level: 'watch' },
      burnLevel: 'medium',
    },
    rates: null,
    compactionCount: 0,
    healthSummary: { mcpFailures: 0 },
    anomalies: [],
    toolCounts: { Read: 28, Edit: 7 },
    rtkStatus: { state: 'off' },
    sessionId: 'render-test',
    activeSessionCount: 1,
    narrow: false,
  };
}
