import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterBySimilarity, makeBm25PairScore, clusterByNeighbors } from './cluster.js';

test('identical artifacts cluster together', () => {
  const artifacts = [
    { path: 'a', body: 'refactor debug edit test function module' },
    { path: 'b', body: 'refactor debug edit test function module' },
    { path: 'c', body: 'prose blog markdown paragraph section heading' },
  ];
  const pairScore = makeBm25PairScore(artifacts);
  const clusters = clusterBySimilarity(artifacts, pairScore, 0.3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
  assert.ok(['a', 'b'].includes(clusters[0].canonical.path));
});

test('disjoint artifacts do not cluster', () => {
  const artifacts = [
    { path: 'a', body: 'refactor debug edit test' },
    { path: 'b', body: 'prose blog markdown heading' },
    { path: 'c', body: 'kubernetes deployment yaml pod' },
  ];
  const pairScore = makeBm25PairScore(artifacts);
  const clusters = clusterBySimilarity(artifacts, pairScore, 0.5);
  assert.equal(clusters.length, 0);
});

test('transitive clustering via union-find', () => {
  // Three highly-similar docs → all three cluster via transitive edges.
  const artifacts = [
    { path: 'a', body: 'refactor debug edit test function module' },
    { path: 'b', body: 'refactor debug edit test function module extra' },
    { path: 'c', body: 'refactor debug edit test function extra more' },
  ];
  const pairScore = makeBm25PairScore(artifacts);
  const clusters = clusterBySimilarity(artifacts, pairScore, 0.3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 3);
});

test('below-threshold pairs are ignored', () => {
  // Disjoint vocabularies → zero BM25 overlap.
  const artifacts = [
    { path: 'a', body: 'refactor debug edit test function module' },
    { path: 'b', body: 'prose blog markdown heading paragraph section' },
  ];
  const pairScore = makeBm25PairScore(artifacts);
  const clusters = clusterBySimilarity(artifacts, pairScore, 0.5);
  assert.equal(clusters.length, 0);
});

test('canonical selection picks the most-central member (highest summed similarity)', () => {
  // Two near-duplicates plus a distinct outlier that only weakly joins.
  const artifacts = [
    { path: 'twin-a', body: 'refactor debug edit test function module' },
    { path: 'twin-b', body: 'refactor debug edit test function module' },
    { path: 'outlier', body: 'refactor something else entirely different' },
  ];
  const pairScore = makeBm25PairScore(artifacts);
  const clusters = clusterBySimilarity(artifacts, pairScore, 0.1);
  assert.equal(clusters.length, 1);
  // Canonical should be one of the two twins (they're symmetric and
  // share more with each other than either shares with the outlier).
  assert.ok(['twin-a', 'twin-b'].includes(clusters[0].canonical.path));
});

// ---- clusterByNeighbors (qmd-style scorer) ------------------------------

test('clusterByNeighbors: builds clusters from declared neighbors', () => {
  const artifacts = [
    { path: '/a', realPath: '/a', body: 'alpha' },
    { path: '/b', realPath: '/b', body: 'beta' },
    { path: '/c', realPath: '/c', body: 'gamma' },
    { path: '/d', realPath: '/d', body: 'delta' },
  ];
  // a↔b strong, c↔d strong, no cross edges.
  const neighborsFn = (a) => ({
    '/a': [{ path: '/b', score: 0.9 }],
    '/b': [{ path: '/a', score: 0.9 }],
    '/c': [{ path: '/d', score: 0.85 }],
    '/d': [{ path: '/c', score: 0.85 }],
  }[a.realPath] ?? []);
  const clusters = clusterByNeighbors(artifacts, neighborsFn, () => 0, 0.55);
  assert.equal(clusters.length, 2);
});

test('clusterByNeighbors: below-threshold edges ignored', () => {
  const artifacts = [
    { path: '/a', realPath: '/a', body: 'x' },
    { path: '/b', realPath: '/b', body: 'y' },
  ];
  const neighborsFn = () => [{ path: '/b', score: 0.3 }];
  const clusters = clusterByNeighbors(artifacts, neighborsFn, () => 0, 0.55);
  assert.equal(clusters.length, 0);
});

test('clusterByNeighbors: null neighbors → BM25 fallback per-artifact', () => {
  const artifacts = [
    { path: '/a', realPath: '/a', body: 'shared tokens debug refactor edit' },
    { path: '/b', realPath: '/b', body: 'shared tokens debug refactor edit' },
  ];
  // qmd returned nothing for either artifact — fallback should kick in.
  const neighborsFn = () => null;
  const fallback = makeBm25PairScore(artifacts);
  const clusters = clusterByNeighbors(artifacts, neighborsFn, fallback, 0.3);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].members.length, 2);
});

test('clusterByNeighbors: unknown paths in neighbor list are ignored', () => {
  const artifacts = [
    { path: '/a', realPath: '/a', body: 'x' },
    { path: '/b', realPath: '/b', body: 'y' },
  ];
  const neighborsFn = () => [{ path: '/ghost', score: 0.99 }];
  const clusters = clusterByNeighbors(artifacts, neighborsFn, () => 0, 0.55);
  assert.equal(clusters.length, 0);
});
