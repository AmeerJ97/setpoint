import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTokenSpike } from './token-spike.js';

describe('checkTokenSpike', () => {
  it('returns null for null/undefined input', () => {
    assert.equal(checkTokenSpike(null), null);
    assert.equal(checkTokenSpike(undefined), null);
  });

  it('returns null when output tokens below threshold', () => {
    assert.equal(checkTokenSpike({ outputTokens: 10000 }), null);
    assert.equal(checkTokenSpike({ outputTokens: 49999 }), null);
    assert.equal(checkTokenSpike({ outputTokens: 50000 }), null); // exactly at threshold
  });

  it('triggers when output tokens exceed threshold', () => {
    const result = checkTokenSpike({ outputTokens: 50001 });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('50,001'));
  });

  it('handles large token counts', () => {
    const result = checkTokenSpike({ outputTokens: 150000 });
    assert.equal(result.triggered, true);
    assert.ok(result.message.includes('150,000'));
  });

  it('handles missing outputTokens field', () => {
    const result = checkTokenSpike({});
    assert.equal(result, null); // 0 tokens, below threshold
  });
});
