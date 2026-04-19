import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkToolDiversity, calculateDiversity } from './tool-diversity.js';

describe('checkToolDiversity', () => {
  it('returns null for invalid input', () => {
    assert.equal(checkToolDiversity(null), null);
    assert.equal(checkToolDiversity({}), null);
    assert.equal(checkToolDiversity({ toolCounts: null }), null);
  });

  it('returns null for sessions with few tool calls', () => {
    // MIN_CALLS_TO_CHECK = 10
    assert.equal(checkToolDiversity({ toolCounts: { Edit: 5, Write: 2 } }), null);
  });

  it('returns null for diverse tool usage', () => {
    const result = checkToolDiversity({
      toolCounts: { Read: 5, Grep: 3, Glob: 2, Edit: 3, Write: 1 },
    });
    assert.equal(result, null); // 5 unique tools
  });

  it('triggers for low diversity (only 1-2 tools)', () => {
    const result = checkToolDiversity({
      toolCounts: { Edit: 12 }, // only 1 tool type
    });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.message.includes('1 tool types'));
  });

  it('includes tool counts in message', () => {
    const result = checkToolDiversity({
      toolCounts: { Edit: 8, Write: 5 }, // 2 tools, 13 calls
    });
    assert.equal(result.triggered, true);
    assert.ok(result.message.includes('Edit:8'));
    assert.ok(result.message.includes('Write:5'));
  });
});

describe('calculateDiversity', () => {
  it('returns zeros for empty input', () => {
    const result = calculateDiversity({});
    assert.equal(result.unique, 0);
    assert.equal(result.total, 0);
    assert.equal(result.score, 0);
  });

  it('calculates correct diversity metrics', () => {
    const result = calculateDiversity({
      Read: 10,
      Grep: 5,
      Edit: 3,
      Write: 2,
    });
    assert.equal(result.unique, 4);
    assert.equal(result.total, 20);
    assert.ok(result.score > 0);
  });
});
