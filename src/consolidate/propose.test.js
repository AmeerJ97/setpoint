import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identity, reconcile, markStatus } from './propose.js';

function raw(kind, sources, target, reason = 'r') {
  return {
    kind, confidence: 0.8, sources, target,
    diffPreview: '', haikuOutput: null, autoApplyable: false, reason,
  };
}

test('identity is stable across reruns and order-independent', () => {
  const a = identity({ kind: 'merge_overlap', sources: ['x', 'y'], target: 'x' });
  const b = identity({ kind: 'merge_overlap', sources: ['y', 'x'], target: 'x' });
  const c = identity({ kind: 'merge_overlap', sources: ['x', 'y'], target: 'y' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('reconcile assigns fresh monotonic ids', () => {
  const store = reconcile([
    raw('merge_overlap', ['a', 'b'], 'a'),
    raw('merge_overlap', ['c', 'd'], 'c'),
  ], { skill: 2 }, { generatedAt: '', sources: {}, proposals: [] });
  assert.equal(store.proposals.length, 2);
  assert.equal(store.proposals[0].id, 'prop-0001');
  assert.equal(store.proposals[1].id, 'prop-0002');
  assert.ok(store.proposals.every(p => p.status === 'pending'));
});

test('reconcile preserves id + status across reruns', () => {
  const first = reconcile(
    [raw('merge_overlap', ['a', 'b'], 'a')],
    { skill: 2 },
    { generatedAt: '', sources: {}, proposals: [] },
  );
  const applied = markStatus(first, 'prop-0001', 'applied');
  // Second scan returns the same logical proposal.
  const second = reconcile(
    [raw('merge_overlap', ['a', 'b'], 'a')],
    { skill: 2 },
    applied,
  );
  // Applied tombstone is retained.
  assert.equal(second.proposals.length, 1);
  assert.equal(second.proposals[0].status, 'applied');
  assert.equal(second.proposals[0].id, 'prop-0001');
});

test('reconcile drops pending proposals that no longer surface', () => {
  const first = reconcile(
    [raw('merge_overlap', ['a', 'b'], 'a'), raw('merge_overlap', ['c', 'd'], 'c')],
    { skill: 4 },
    { generatedAt: '', sources: {}, proposals: [] },
  );
  // Rerun with only the first.
  const second = reconcile(
    [raw('merge_overlap', ['a', 'b'], 'a')],
    { skill: 2 },
    first,
  );
  assert.equal(second.proposals.length, 1);
  assert.equal(second.proposals[0].sources.join(','), 'a,b');
});

test('new proposals get next id even when tombstones exist', () => {
  const first = reconcile(
    [raw('merge_overlap', ['a', 'b'], 'a')],
    { skill: 2 },
    { generatedAt: '', sources: {}, proposals: [] },
  );
  const applied = markStatus(first, 'prop-0001', 'applied');
  const second = reconcile(
    [raw('merge_overlap', ['x', 'y'], 'x')],
    { skill: 2 },
    applied,
  );
  // Tombstone + one fresh → 2 entries, fresh has id prop-0002
  assert.equal(second.proposals.length, 2);
  const fresh = second.proposals.find(p => p.status === 'pending');
  assert.equal(fresh.id, 'prop-0002');
});
