import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countReasoningReversals, reversalsPer1k } from './reversals.js';

describe('countReasoningReversals', () => {
  it('returns 0 on empty input', () => {
    assert.equal(countReasoningReversals(''), 0);
    assert.equal(countReasoningReversals(null), 0);
    assert.equal(countReasoningReversals(undefined), 0);
  });

  it('catches the canonical phrases', () => {
    const text = `
      Wait, that's not right.
      Actually, the path is different.
      Let me fix that.
      Hmm, on second thought.
      Sorry, I was wrong about the import.
      My mistake — the field is named differently.
    `;
    const n = countReasoningReversals(text);
    assert.ok(n >= 6, `expected >= 6 matches, got ${n}`);
  });

  it('is case-insensitive', () => {
    assert.ok(countReasoningReversals('WAIT — actually, no.') >= 2);
  });

  it('does not match unrelated words like "actuallyish"', () => {
    // \b boundary should keep "actually" from matching inside other tokens
    assert.equal(countReasoningReversals('the value is actuallyish wrong'), 0);
  });

  it('counts multiple matches in the same string', () => {
    assert.equal(countReasoningReversals('wait wait wait'), 3);
  });
});

describe('reversalsPer1k', () => {
  it('returns 0 when toolCallCount is too small to be meaningful', () => {
    assert.equal(reversalsPer1k(2, 5), 0);
  });

  it('scales correctly to 1k base', () => {
    // 5 reversals over 100 tool calls = 50/1k
    assert.equal(reversalsPer1k(5, 100), 50);
  });

  it('returns 0 on zero tool calls', () => {
    assert.equal(reversalsPer1k(10, 0), 0);
  });
});
