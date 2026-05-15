import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shannonEntropy, contentHash, captureSnapshot, diffSnapshot } from './entropy.js';
import { decideScan, cachedProbe } from './gate.js';

test('shannonEntropy: uniform bytes ≈ 8, single-char = 0', () => {
  assert.equal(shannonEntropy(''), 0);
  assert.equal(shannonEntropy('aaaaaa'), 0);
  const rand = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
  const h = shannonEntropy(rand);
  assert.ok(h > 7.9 && h <= 8, `expected near-uniform ≈ 8, got ${h}`);
});

test('contentHash is stable and differs on mutation', () => {
  const a = contentHash('hello world');
  const b = contentHash('hello world');
  const c = contentHash('hello worlD');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('captureSnapshot + diffSnapshot: first run lists everything added', () => {
  const arts = [
    { kind: 'skill', realPath: '/x/a', body: 'foo bar baz' },
    { kind: 'skill', realPath: '/x/b', body: 'another body' },
  ];
  const snap = captureSnapshot(arts);
  const delta = diffSnapshot(null, snap);
  assert.equal(delta.added.length, 2);
  assert.equal(delta.changed.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.novelty, 1);
});

test('diffSnapshot: identical corpus → zero novelty', () => {
  const arts = [{ kind: 'skill', realPath: '/x/a', body: 'foo bar baz' }];
  const s1 = captureSnapshot(arts);
  const s2 = captureSnapshot(arts);
  const delta = diffSnapshot(s1, s2);
  assert.equal(delta.added.length, 0);
  assert.equal(delta.changed.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.novelty, 0);
});

test('diffSnapshot: one changed file registers proportional novelty', () => {
  const prev = captureSnapshot([
    { kind: 'skill', realPath: '/x/a', body: 'original alpha'.repeat(20) },
    { kind: 'skill', realPath: '/x/b', body: 'beta body stays same'.repeat(20) },
  ]);
  const curr = captureSnapshot([
    { kind: 'skill', realPath: '/x/a', body: 'modified alpha now completely different content and longer'.repeat(20) },
    { kind: 'skill', realPath: '/x/b', body: 'beta body stays same'.repeat(20) },
  ]);
  const delta = diffSnapshot(prev, curr);
  assert.equal(delta.changed.length, 1);
  assert.ok(delta.novelty > 0 && delta.novelty < 1, `expected intermediate novelty, got ${delta.novelty}`);
});

test('decideScan: first run never skips', () => {
  const arts = [{ kind: 'skill', realPath: '/x/a', body: 'hello' }];
  const { skip, snapshot, delta } = decideScan({ artifacts: arts, state: { snapshot: null, probes: {}, lastScanAt: 0 } });
  assert.equal(skip, false);
  assert.equal(snapshot.count, 1);
  assert.equal(delta.added.length, 1);
});

test('decideScan: identical corpus → skip', () => {
  const arts = [{ kind: 'skill', realPath: '/x/a', body: 'hello world this is a skill body' }];
  const first = decideScan({ artifacts: arts, state: { snapshot: null, probes: {}, lastScanAt: 0 } });
  const second = decideScan({ artifacts: arts, state: { snapshot: first.snapshot, probes: {}, lastScanAt: Date.now() } });
  assert.equal(second.skip, true);
  assert.match(second.reason, /no files changed/);
});

test('decideScan: below-threshold novelty → skip with reason', () => {
  const base = { kind: 'skill', realPath: '/x/a', body: 'alpha body '.repeat(500) };
  const tweak = { kind: 'skill', realPath: '/x/b', body: 'beta body '.repeat(500) };
  const first = decideScan({
    artifacts: [base, tweak],
    state: { snapshot: null, probes: {}, lastScanAt: 0 },
  });
  // Single-character edit on b — tiny novelty on a large corpus.
  const nudged = { ...tweak, body: tweak.body + 'x' };
  const second = decideScan({
    artifacts: [base, nudged],
    state: { snapshot: first.snapshot, probes: {}, lastScanAt: Date.now() },
    threshold: 0.5,  // very strict so even this small change fails it
  });
  assert.equal(second.skip, true);
  assert.match(second.reason, /novelty/);
});

test('cachedProbe caches within TTL and re-probes after expiry', () => {
  const state = { snapshot: null, probes: {}, lastScanAt: 0 };
  let called = 0;
  const probe = () => { called++; return true; };
  const a = cachedProbe('tool', probe, state, 60_000);
  assert.equal(a.ok, true); assert.equal(a.cached, false); assert.equal(called, 1);
  const b = cachedProbe('tool', probe, state, 60_000);
  assert.equal(b.cached, true); assert.equal(called, 1);
  // Expire the cache.
  state.probes.tool.at = Date.now() - 120_000;
  const c = cachedProbe('tool', probe, state, 60_000);
  assert.equal(c.cached, false); assert.equal(called, 2);
});
