import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatParseError, formatStructuredError } from './errors.js';

describe('formatParseError', () => {
  it('writes to stderr with prefix', () => {
    const messages = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { messages.push(chunk.toString()); return true; };
    try {
      formatParseError('test message');
      assert.ok(messages.some(m => m.includes('[claude-ops]') && m.includes('test message')));
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('formatStructuredError', () => {
  it('formats Error instances with stack', () => {
    const err = new Error('boom');
    const result = formatStructuredError('test', err);
    assert.equal(result.context, 'test');
    assert.equal(result.message, 'boom');
    assert.ok(result.stack);
  });

  it('formats non-Error thrown values', () => {
    assert.deepEqual(formatStructuredError('ctx', 'string error'), { context: 'ctx', message: 'string error' });
    assert.deepEqual(formatStructuredError('ctx', 42), { context: 'ctx', message: '42' });
    assert.deepEqual(formatStructuredError('ctx', null), { context: 'ctx', message: 'Unknown error' });
    assert.deepEqual(formatStructuredError('ctx', undefined), { context: 'ctx', message: 'Unknown error' });
  });
});
