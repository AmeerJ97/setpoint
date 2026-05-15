import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderUsageLine } from './usage.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function ctx({ fhCurrent = 50, fhTte = null, sdCurrent = 30, sdTte = null, narrow = false } = {}) {
  return {
    narrow,
    usageData: {
      fiveHour: fhCurrent,
      sevenDay: sdCurrent,
      fiveHourResetAt: new Date(Date.now() + 3600_000),
      sevenDayResetAt: new Date(Date.now() + 86400_000),
    },
    advisory: {
      fiveHour: { current: fhCurrent, projected: fhCurrent + 10, level: 'watch', tte: fhTte, peakActive: false, peakFraction: 0, peakMultiplier: 1 },
      sevenDay: { current: sdCurrent, projected: sdCurrent + 5,  level: 'ok',    tte: sdTte, peakActive: false, peakFraction: 0, peakMultiplier: 1 },
    },
  };
}

function apiCtx({ authProvider = 'api-key', narrow = false } = {}) {
  const backend = authProvider === 'vertex' ? 'vertex-ai'
    : (authProvider === 'api-key' || authProvider === 'auth-token') ? 'anthropic-api'
    : authProvider === 'console' ? 'anthropic-console'
    : authProvider;
  return {
    narrow,
    billingSignal: 'cost-metered',
    authProvider,
    mode: 'api',
    runtimeMode: {
      authProvider,
      billingSignal: 'cost-metered',
      mode: authProvider === 'bedrock' ? 'bedrock' : 'api',
      backend,
      telemetryAuthority: authProvider === 'vertex' ? 'local-synthetic' : 'local-cost',
    },
    apiWindowRefs: {
      sessionCostUsd: 1.24,
      ref5hCostUsd: 2.80,
      ref7dCostUsd: 19.60,
      sessionCostPct5h: 44,
      sessionCostPct7d: 6,
      historySamples: 12,
      level5h: 'ok',
      level7d: 'ok',
    },
  };
}

// TTE moved to Advisor line in Phase 6C — Usage line must no longer render it.
test('TTE is not rendered on the Usage line (moved to Advisor)', () => {
  const danger5h = strip(renderUsageLine(ctx({ fhTte: 25 * 60 })));
  const danger7d = strip(renderUsageLine(ctx({ sdTte: 6 * 3600 })));
  const safe = strip(renderUsageLine(ctx({ fhTte: 4 * 3600 })));
  for (const out of [danger5h, danger7d, safe]) {
    assert.doesNotMatch(out, /hits in/, 'Usage line should never render TTE');
    assert.doesNotMatch(out, /TTE/);
  }
});

test('limit-reached banner still replaces the Usage line', () => {
  const c = ctx({ fhTte: 25 * 60 });
  c.usageData.fiveHour = 100;
  const out = strip(renderUsageLine(c));
  assert.match(out, /Limit reached/);
});

test('peak-hour ⚡ glyph is shown when peak window is active', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = true;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 1;
  const out = strip(renderUsageLine(c));
  assert.match(out, /⚡/, 'expected lit ⚡ glyph during active peak window');
});

test('peak-hour ⚡ glyph is shown dim when peak hours are merely upcoming', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = false;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 0.4;
  const out = strip(renderUsageLine(c));
  assert.match(out, /⚡/, 'expected ⚡ glyph when peak hours upcoming inside the remaining window');
});

test('peak-hour ⚡ glyph is hidden when peak share is negligible', () => {
  const c = ctx();
  c.advisory.fiveHour.peakActive = false;
  c.advisory.fiveHour.peakMultiplier = 1.5;
  c.advisory.fiveHour.peakFraction = 0.05;
  const out = strip(renderUsageLine(c));
  assert.doesNotMatch(out, /⚡/);
});

test('API billing mode renders cost references instead of quota placeholders', () => {
  const out = strip(renderUsageLine(apiCtx()));
  assert.match(out, /Usage\s+5h:/);
  assert.match(out, /~\$1\.2/);
  assert.match(out, /ref:\$2\.8/);
  assert.doesNotMatch(out, /\[(ANTHROPIC|VERTEX|BEDROCK|GATEWAY|FOUNDRY|COST)/);
  assert.doesNotMatch(out, /--%/);
});

test('narrow API billing mode shows 7d reference cost when present', () => {
  const out = strip(renderUsageLine(apiCtx({ narrow: true })));
  assert.match(out, /Use\s+~?\$1\.2/);
  assert.doesNotMatch(out, /\[(ANTHROPIC|VERTEX|BEDROCK|GATEWAY|FOUNDRY|COST)/);
  assert.match(out, /\~?\$1\.2\s+\(5h\)/);
  assert.match(out, /\~\$\d+/);
  assert.match(out, /\(7d\)/);
});

test('gateway cost mode leaves provider identity to Model line', () => {
  const out = strip(renderUsageLine(apiCtx({ authProvider: 'gateway' })));
  assert.match(out, /Usage\s+5h:/);
  assert.doesNotMatch(out, /\[GATEWAY\]/);
});


test('vertex usage line marks api-backed telemetry when authority is vertex-api', () => {
  const c = apiCtx({ authProvider: 'vertex' });
  c.runtimeMode.telemetryAuthority = 'vertex-api';
  c.vertexTelemetry = {
    telemetryAuthority: 'vertex-api',
    dataMaturity: { state: 'authoritative' },
    fiveHour: { totalTokens: 1234, cacheCreateTokens: 10, cacheReadTokens: 4, costUsd: 6.5 },
    sevenDay: { totalTokens: 4567, costUsd: 45.2 },
    latestQuotaEvent: null,
  };
  const out = strip(renderUsageLine(c));
  assert.match(out, /Usage\s+\$6\.5\s+api\s+[|│]\s+5h:/);
  assert.doesNotMatch(out, /\[VERTEX-AI\]/);
});


test('vertex usage line renders $0.00 when authoritative API reports zero cost', () => {
  const c = apiCtx({ authProvider: 'vertex' });
  c.runtimeMode.telemetryAuthority = 'vertex-api';
  c.vertexTelemetry = {
    telemetryAuthority: 'vertex-api',
    dataMaturity: { state: 'authoritative' },
    fiveHour: { totalTokens: 1234, cacheCreateTokens: 10, cacheReadTokens: 4, costUsd: 0 },
    sevenDay: { totalTokens: 4567, costUsd: 0 },
    latestQuotaEvent: null,
  };
  const out = strip(renderUsageLine(c));
  assert.match(out, /\$0.00/);
  assert.doesNotMatch(out, /api-cost:missing/);
});

test('cost-metered provider labels are omitted from Usage for supported auth adapters', () => {
  const cases = [
    'api-key',
    'auth-token',
    'console',
    'bedrock',
    'vertex',
    'foundry',
    'unknown',
  ];
  for (const authProvider of cases) {
    const out = strip(renderUsageLine(apiCtx({ authProvider })));
    if (authProvider === 'vertex') {
      assert.match(out, /Usage\s+telem:miss/, authProvider);
      assert.doesNotMatch(out, /ref:\$/);
    } else {
      assert.match(out, /Usage\s+5h:/, authProvider);
    }
    assert.doesNotMatch(out, /\[(ANTHROPIC|VERTEX|BEDROCK|GATEWAY|FOUNDRY|COST)/, authProvider);
  }
});

test('subscription usage line omits Anthropic Pro backend badge', () => {
  const out = strip(renderUsageLine({
    ...ctx(),
    billingSignal: 'quota-window',
    runtimeMode: {
      authProvider: 'subscription',
      billingSignal: 'quota-window',
      mode: 'max',
      backend: 'anthropic-pro',
      telemetryAuthority: 'server-rate-limits',
    },
  }));
  assert.match(out, /Usage\s+5h/);
  assert.doesNotMatch(out, /\[ANTHROPIC-PRO\]/);
});
