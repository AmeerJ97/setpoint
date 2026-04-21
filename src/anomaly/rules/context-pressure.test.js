import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkContextPressure } from './context-pressure.js';

describe('checkContextPressure', () => {
  it('returns null for invalid input', () => {
    assert.equal(checkContextPressure(null), null);
    assert.equal(checkContextPressure({}), null);
    assert.equal(checkContextPressure({ contextPercent: NaN }), null);
    assert.equal(checkContextPressure({ contextPercent: -10 }), null);
  });

  it('returns null for low context usage', () => {
    assert.equal(checkContextPressure({ contextPercent: 30 }), null);
    assert.equal(checkContextPressure({ contextPercent: 50 }), null);
    assert.equal(checkContextPressure({ contextPercent: 69 }), null);
  });

  it('triggers warn at 70%+ without compaction', () => {
    const result = checkContextPressure({ contextPercent: 72, compactionCount: 0 });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('72%'));
  });

  it('does not warn at 70% with compaction', () => {
    const result = checkContextPressure({ contextPercent: 72, compactionCount: 1 });
    assert.equal(result, null);
  });

  it('triggers critical at 85%+', () => {
    const result = checkContextPressure({ contextPercent: 88 });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
    assert.ok(result.message.includes('88%'));
    assert.ok(result.message.includes('compact'));
  });

  it('triggers critical regardless of compaction count', () => {
    const result = checkContextPressure({ contextPercent: 90, compactionCount: 3 });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
  });
});
