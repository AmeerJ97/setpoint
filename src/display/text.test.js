import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, visualLength, sliceVisible, truncateToWidth, wrapLineToWidth } from './text.js';

describe('stripAnsi', () => {
  it('removes ANSI escape sequences', () => {
    assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
    assert.equal(stripAnsi('no ansi'), 'no ansi');
    assert.equal(stripAnsi('\x1b[1m\x1b[32mbold green\x1b[0m'), 'bold green');
  });
});

describe('visualLength', () => {
  it('counts plain ASCII correctly', () => {
    assert.equal(visualLength('hello'), 5);
    assert.equal(visualLength(''), 0);
  });

  it('ignores ANSI escape sequences', () => {
    assert.equal(visualLength('\x1b[31mred\x1b[0m'), 3);
    assert.equal(visualLength('\x1b[1m\x1b[32mBG\x1b[0m'), 2);
  });

  it('counts wide CJK characters as 2', () => {
    assert.equal(visualLength('你好'), 4);
    assert.equal(visualLength('a你b'), 4);
  });

  it('counts emoji as 2', () => {
    assert.equal(visualLength('👍'), 2);
    assert.equal(visualLength('hi 👋'), 5);
  });

  it('handles block characters correctly', () => {
    assert.equal(visualLength('█░'), 2);
    assert.equal(visualLength('████░░░░'), 8);
  });
});

describe('sliceVisible', () => {
  it('slices to visible width', () => {
    assert.equal(sliceVisible('hello world', 5), 'hello');
  });

  it('preserves ANSI escapes', () => {
    const result = sliceVisible('\x1b[31mhello\x1b[0m world', 5);
    assert.ok(result.includes('\x1b[31m'));
    assert.equal(stripAnsi(result), 'hello');
  });

  it('handles zero width', () => {
    assert.equal(sliceVisible('hello', 0), '');
  });

  it('returns full string if within width', () => {
    assert.equal(sliceVisible('hi', 10), 'hi');
  });
});

describe('truncateToWidth', () => {
  it('adds ellipsis when truncating', () => {
    const result = truncateToWidth('hello world', 8);
    assert.ok(stripAnsi(result).endsWith('...'));
    assert.ok(visualLength(result) <= 8);
  });

  it('returns original if fits', () => {
    assert.equal(truncateToWidth('hi', 10), 'hi');
  });
});

describe('wrapLineToWidth', () => {
  it('returns single line if fits', () => {
    const lines = wrapLineToWidth('short', 80);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'short');
  });

  it('wraps at separator boundaries', () => {
    const long = 'part1 | part2 | part3';
    const lines = wrapLineToWidth(long, 15);
    assert.ok(lines.length >= 2);
  });

  it('keeps model badge atomic', () => {
    const line = '\x1b[36m[Opus 4.6 | Bedrock]\x1b[0m some-project';
    const lines = wrapLineToWidth(line, 30);
    // The model badge should not be split
    const firstStripped = stripAnsi(lines[0]);
    if (firstStripped.includes('[')) {
      assert.ok(firstStripped.includes(']'), 'model badge should stay atomic');
    }
  });
});
