import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolCounts } from './pipeline.js';

test('buildToolCounts counts only named tools', () => {
  const counts = buildToolCounts([
    { name: 'Read' },
    { name: 'Read' },
    { name: 'Bash' },
    {},
    { name: '' },
    null,
  ]);

  assert.deepEqual(counts, {
    Read: 2,
    Bash: 1,
  });
});
