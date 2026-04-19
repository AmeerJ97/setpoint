import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_TOOLS,
  WRITE_TOOLS,
  RE_RATIO_HEALTHY,
  RE_RATIO_WARN,
  RE_RATIO_CRITICAL,
  countReadEdits,
  calculateRatio,
  isOpus,
} from './constants.js';

describe('READ_TOOLS', () => {
  it('contains expected research tools', () => {
    assert.ok(READ_TOOLS.has('Read'));
    assert.ok(READ_TOOLS.has('Grep'));
    assert.ok(READ_TOOLS.has('Glob'));
    assert.ok(READ_TOOLS.has('WebSearch'));
    assert.ok(READ_TOOLS.has('WebFetch'));
    assert.ok(READ_TOOLS.has('LSP'));
  });

  it('does not contain write tools', () => {
    assert.ok(!READ_TOOLS.has('Edit'));
    assert.ok(!READ_TOOLS.has('Write'));
  });
});

describe('WRITE_TOOLS', () => {
  it('contains expected mutation tools', () => {
    assert.ok(WRITE_TOOLS.has('Edit'));
    assert.ok(WRITE_TOOLS.has('Write'));
    assert.ok(WRITE_TOOLS.has('NotebookEdit'));
  });

  it('does not contain read tools', () => {
    assert.ok(!WRITE_TOOLS.has('Read'));
    assert.ok(!WRITE_TOOLS.has('Grep'));
  });
});

describe('ratio thresholds', () => {
  it('has correct ordering', () => {
    assert.ok(RE_RATIO_HEALTHY > RE_RATIO_WARN);
    assert.ok(RE_RATIO_WARN > RE_RATIO_CRITICAL);
  });

  it('has expected values', () => {
    assert.equal(RE_RATIO_HEALTHY, 3.0);
    assert.equal(RE_RATIO_WARN, 2.0);
    assert.equal(RE_RATIO_CRITICAL, 1.0);
  });
});

describe('countReadEdits', () => {
  it('counts read tools correctly', () => {
    const result = countReadEdits({
      Read: 5,
      Grep: 3,
      Glob: 2,
      WebSearch: 1,
      WebFetch: 1,
      LSP: 1,
    });
    assert.equal(result.reads, 13);
    assert.equal(result.edits, 0);
  });

  it('counts write tools correctly', () => {
    const result = countReadEdits({
      Edit: 3,
      Write: 2,
      NotebookEdit: 1,
    });
    assert.equal(result.reads, 0);
    assert.equal(result.edits, 6);
  });

  it('counts both read and write tools', () => {
    const result = countReadEdits({
      Read: 10,
      Grep: 5,
      Edit: 3,
      Write: 1,
    });
    assert.equal(result.reads, 15);
    assert.equal(result.edits, 4);
  });

  it('ignores unknown tools', () => {
    const result = countReadEdits({
      Read: 5,
      Bash: 10,
      Agent: 3,
      Edit: 2,
    });
    assert.equal(result.reads, 5);
    assert.equal(result.edits, 2);
  });

  it('handles empty object', () => {
    const result = countReadEdits({});
    assert.equal(result.reads, 0);
    assert.equal(result.edits, 0);
  });
});

describe('calculateRatio', () => {
  it('calculates normal ratio', () => {
    assert.equal(calculateRatio(10, 2), 5);
    assert.equal(calculateRatio(6, 3), 2);
  });

  it('returns Infinity for zero edits with reads', () => {
    assert.equal(calculateRatio(10, 0), Infinity);
  });

  it('returns 0 for zero reads and zero edits', () => {
    assert.equal(calculateRatio(0, 0), 0);
  });

  it('handles fractional results', () => {
    assert.ok(Math.abs(calculateRatio(5, 3) - 1.6666666666666667) < 0.001);
  });
});

describe('isOpus', () => {
  it('detects Opus in various formats', () => {
    assert.equal(isOpus('Claude Opus 4.6'), true);
    assert.equal(isOpus('claude-opus-4-6'), true);
    assert.equal(isOpus('Opus 4.5'), true);
    assert.equal(isOpus('opus'), true);
    assert.equal(isOpus('OPUS'), true);
  });

  it('returns false for non-Opus models', () => {
    assert.equal(isOpus('Claude Sonnet 4.6'), false);
    assert.equal(isOpus('claude-haiku-4-5'), false);
    assert.equal(isOpus('gpt-4'), false);
  });

  it('handles null/undefined', () => {
    assert.equal(isOpus(null), false);
    assert.equal(isOpus(undefined), false);
    assert.equal(isOpus(''), false);
  });
});
