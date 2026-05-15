/**
 * Consolidate — overlap clustering.
 *
 * Given a list of artifacts, emits clusters (size ≥ 2) where every
 * member is pairwise-similar above `simThreshold`. No HDBSCAN, no UMAP
 * — classic union-find connected components over an undirected
 * similarity graph. Works identically whether the similarity came from
 * qmd vectors or in-repo BM25 — we just take a `pairScore(a, b)`
 * callback.
 *
 * The canonical member of a cluster is the artifact with the highest
 * summed in-cluster similarity (the "most central"); ties broken by
 * shortest body.
 */

import { tokenCounts, bm25Score, } from '../advisor/semantic-engine.js';

const DEFAULT_SIM = 0.45; // BM25 scale; vector similarity uses a different default

/**
 * Simple union-find.
 */
class DSU {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
    this.r = Array(n).fill(0);
  }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    if (this.r[ra] < this.r[rb]) this.p[ra] = rb;
    else if (this.r[ra] > this.r[rb]) this.p[rb] = ra;
    else { this.p[rb] = ra; this.r[ra]++; }
    return true;
  }
}

/**
 * Build clusters from pairwise scores.
 *
 * @param {Array<{path:string, body:string}>} artifacts
 * @param {(a:object, b:object) => number} pairScore
 * @param {number} [simThreshold=DEFAULT_SIM]
 * @returns {Array<{members: object[], canonical: object, scores: Map}>}
 */
export function clusterBySimilarity(artifacts, pairScore, simThreshold = DEFAULT_SIM) {
  const n = artifacts.length;
  if (n < 2) return [];
  const dsu = new DSU(n);
  const pairScores = new Map(); // key "i:j" (i<j) → score
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = pairScore(artifacts[i], artifacts[j]);
      if (s >= simThreshold) {
        dsu.union(i, j);
        pairScores.set(`${i}:${j}`, s);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const clusters = [];
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    // Pick canonical = highest summed in-cluster pair score; tie → shortest body.
    let best = idxs[0], bestSum = -Infinity, bestLen = Infinity;
    for (const i of idxs) {
      let sum = 0;
      for (const j of idxs) {
        if (i === j) continue;
        const [lo, hi] = i < j ? [i, j] : [j, i];
        sum += pairScores.get(`${lo}:${hi}`) ?? 0;
      }
      const len = artifacts[i].body.length;
      if (sum > bestSum || (sum === bestSum && len < bestLen)) {
        best = i; bestSum = sum; bestLen = len;
      }
    }
    clusters.push({
      members: idxs.map(i => artifacts[i]),
      canonical: artifacts[best],
      scores: pairScores,
    });
  }
  return clusters;
}

/**
 * Build clusters from a neighbor-list graph instead of scoring every
 * pair. Intended for qmd vector search — we call `neighborsFn(artifact)
 * → [{path, score}, ...]` once per artifact and union any edge whose
 * similarity is above threshold.
 *
 * Falls back to the caller's BM25 pair score when `neighborsFn` returns
 * null for a given artifact (e.g. qmd didn't index it) — so a per-file
 * qmd failure doesn't silently drop that artifact from clustering.
 *
 * @param {Array<{path:string, realPath:string, body:string}>} artifacts
 * @param {(a:object) => null | {path: string, score: number}[]} neighborsFn
 * @param {(a:object, b:object) => number} fallbackPairScore
 * @param {number} [simThreshold]
 * @returns {ReturnType<typeof clusterBySimilarity>}
 */
export function clusterByNeighbors(artifacts, neighborsFn, fallbackPairScore, simThreshold = 0.55) {
  const n = artifacts.length;
  if (n < 2) return [];
  const pathToIdx = new Map();
  for (let i = 0; i < n; i++) {
    pathToIdx.set(artifacts[i].realPath, i);
    // Also index by logical path — qmd may report either.
    if (artifacts[i].path && artifacts[i].path !== artifacts[i].realPath) {
      pathToIdx.set(artifacts[i].path, i);
    }
  }

  const dsu = new DSU(n);
  const pairScores = new Map();
  const setPair = (i, j, s) => {
    const [lo, hi] = i < j ? [i, j] : [j, i];
    const key = `${lo}:${hi}`;
    const existing = pairScores.get(key);
    if (!existing || s > existing) pairScores.set(key, s);
  };

  for (let i = 0; i < n; i++) {
    const neighbors = neighborsFn(artifacts[i]);
    if (!neighbors) {
      // Fall back to pairwise BM25 for this artifact so we don't lose it.
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const s = fallbackPairScore(artifacts[i], artifacts[j]);
        if (s >= simThreshold) { dsu.union(i, j); setPair(i, j, s); }
      }
      continue;
    }
    for (const nb of neighbors) {
      const j = pathToIdx.get(nb.path);
      if (j == null || j === i) continue;
      if (nb.score >= simThreshold) { dsu.union(i, j); setPair(i, j, nb.score); }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = dsu.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const clusters = [];
  for (const [, idxs] of groups) {
    if (idxs.length < 2) continue;
    let best = idxs[0], bestSum = -Infinity, bestLen = Infinity;
    for (const i of idxs) {
      let sum = 0;
      for (const j of idxs) {
        if (i === j) continue;
        const [lo, hi] = i < j ? [i, j] : [j, i];
        sum += pairScores.get(`${lo}:${hi}`) ?? 0;
      }
      const len = artifacts[i].body.length;
      if (sum > bestSum || (sum === bestSum && len < bestLen)) {
        best = i; bestSum = sum; bestLen = len;
      }
    }
    clusters.push({ members: idxs.map(i => artifacts[i]), canonical: artifacts[best], scores: pairScores });
  }
  return clusters;
}

/**
 * BM25-based pairScore factory. Pre-tokenizes every artifact once so
 * the N² pair loop stays cheap.
 *
 * @param {Array<{body: string}>} artifacts
 * @returns {(a:object, b:object) => number}
 */
export function makeBm25PairScore(artifacts) {
  // Build a mini-corpus so we can compute IDF.
  const docs = new Map(); // artifact → { counts, tokens, length }
  const df = new Map();
  let totalLen = 0;
  for (const a of artifacts) {
    const { counts, length } = tokenCounts(a.body);
    const tokens = new Set(counts.keys());
    docs.set(a, { counts, tokens, length });
    totalLen += length;
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = artifacts.length;
  const avgdl = N > 0 ? totalLen / N : 0;
  const corpus = { df, N, avgdl, profiles: new Map() };

  // Symmetric scorer: avg of score(a→b) and score(b→a), normalized by
  // the max possible self-score so the threshold stays in a [0,1]-ish band.
  return (a, b) => {
    const da = docs.get(a), db = docs.get(b);
    if (!da || !db || da.length === 0 || db.length === 0) return 0;
    const aSelf = bm25Score(da.tokens, da, corpus);
    const bSelf = bm25Score(db.tokens, db, corpus);
    const ab = bm25Score(da.tokens, db, corpus);
    const ba = bm25Score(db.tokens, da, corpus);
    const norm = Math.max(aSelf, bSelf);
    if (norm <= 0) return 0;
    return ((ab + ba) / 2) / norm;
  };
}
