import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkReadEditRatio } from './read-edit-ratio.js';

describe('checkReadEditRatio', () => {
  it('returns null when no toolCounts provided', () => {
    assert.equal(checkReadEditRatio({}), null);
    assert.equal(checkReadEditRatio({ toolCounts: null }), null);
    assert.equal(checkReadEditRatio(null), null);
    assert.equal(checkReadEditRatio(undefined), null);
  });

  it('returns null when edits below minimum threshold', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 10, Edit: 2 }, // MIN_EDITS_TO_TRIGGER = 3
    });
    assert.equal(result, null);
  });

  it('returns ok when ratio is healthy (>= 3.0)', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 15, Grep: 5, Edit: 5, Write: 1 }, // 20 reads / 6 edits = 3.33
    });
    assert.equal(result.triggered, false);
    assert.equal(result.severity, 'ok');
    assert.ok(result.ratio >= 3.0);
    assert.equal(result.reads, 20);
    assert.equal(result.edits, 6);
  });

  it('returns warn when ratio is low (< 2.0) but not critical', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 6, Edit: 4 }, // 6/4 = 1.5
    });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn');
    assert.ok(result.ratio < 2.0);
    assert.ok(result.ratio >= 1.0);
  });

  it('returns warn (not critical) for non-Opus models even at critical ratio', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 2, Edit: 4 }, // 0.5 ratio - critically low
      modelName: 'Claude Sonnet 4.6',
    });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'warn'); // NOT critical for Sonnet
    assert.ok(result.ratio < 1.0);
  });

  it('returns critical for Opus when ratio < 1.0', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 2, Edit: 4 }, // 0.5 ratio
      modelName: 'Claude Opus 4.6',
    });
    assert.equal(result.triggered, true);
    assert.equal(result.severity, 'critical');
    assert.ok(result.ratio < 1.0);
  });

  it('detects Opus in various model name formats', () => {
    const toolCounts = { Read: 2, Edit: 4 }; // 0.5 ratio

    const formats = [
      'Claude Opus 4.6',
      'claude-opus-4-6',
      'Opus 4.5',
      'opus',
      'OPUS',
    ];

    for (const modelName of formats) {
      const result = checkReadEditRatio({ toolCounts, modelName });
      assert.equal(result.severity, 'critical', `Failed for: ${modelName}`);
    }
  });

  it('counts all read tools correctly', () => {
    const result = checkReadEditRatio({
      toolCounts: {
        Read: 5,
        Grep: 3,
        Glob: 2,
        WebSearch: 1,
        WebFetch: 1,
        LSP: 1,
        Edit: 3,
        Write: 1,
      },
    });
    assert.equal(result.reads, 13); // 5+3+2+1+1+1
    assert.equal(result.edits, 4);  // 3+1
  });

  it('counts all write tools correctly', () => {
    const result = checkReadEditRatio({
      toolCounts: {
        Read: 12,
        Edit: 2,
        Write: 1,
        NotebookEdit: 1,
      },
    });
    assert.equal(result.edits, 4); // 2+1+1
    assert.equal(result.reads, 12);
  });

  it('handles missing model name gracefully', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 2, Edit: 4 },
      // modelName not provided
    });
    // Without modelName, critical threshold doesn't apply
    assert.equal(result.severity, 'warn');
  });

  it('includes ratio in message', () => {
    const result = checkReadEditRatio({
      toolCounts: { Read: 6, Edit: 4 },
    });
    assert.ok(result.message.includes('1.5'));
    assert.ok(result.message.includes('6r'));
    assert.ok(result.message.includes('4e'));
  });
});
