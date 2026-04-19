import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkBackgroundDrain } from './background-drain.js';

describe('checkBackgroundDrain', () => {
  it('returns array (may be empty depending on system state)', () => {
    // This function checks real system state, so we just verify it returns an array
    const result = checkBackgroundDrain();
    assert.ok(Array.isArray(result));
  });

  it('each alert has required fields', () => {
    const result = checkBackgroundDrain();
    for (const alert of result) {
      assert.ok('triggered' in alert);
      assert.ok('message' in alert);
      assert.ok('severity' in alert);
      assert.ok(['warn', 'critical'].includes(alert.severity));
    }
  });

  // Note: We can't easily test the positive cases without mocking
  // the filesystem and process checks. The function is designed to
  // be safe (read-only, short timeouts, no interference with processes).
});
