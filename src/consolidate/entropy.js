/**
 * Corpus-state snapshot + novelty / entropy heuristic.
 *
 * Inspired by engram's RPE gate (bypass vs. buffer vs. trigger) but
 * without any of the ML machinery. We compute:
 *
 *   - Shannon entropy H(f) of the byte distribution per artifact
 *     (cheap proxy for "how information-dense is this file").
 *   - A stable content hash (sha1[:10]) per artifact.
 *   - A per-file { mtime, hash, entropy, size } snapshot.
 *   - A corpus delta between two snapshots: added / removed / changed
 *     sets + scalar `novelty` = fraction of the corpus that shifted,
 *     weighted by per-file entropy.
 *
 * The scan gate reads two snapshots (last + current) and short-circuits
 * the expensive BM25 + Haiku passes when novelty is below a threshold.
 * Nothing here is novel cryptography or IR theory — just enough signal
 * to avoid repeating work when the skills tree hasn't meaningfully
 * moved since the last scan.
 */

import { createHash } from 'node:crypto';

/**
 * Shannon entropy of the byte distribution of `text`, in bits per byte.
 * 0 means pure-repetition; log2(256) ≈ 8 means uniform random.
 *
 * @param {string} text
 * @returns {number}
 */
export function shannonEntropy(text) {
  if (!text) return 0;
  const freq = new Map();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  const n = text.length;
  let h = 0;
  for (const count of freq.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Stable short content hash — sha1 hex, first 10 chars. Enough to
 * detect body changes; not meant for collision resistance in an
 * adversarial setting.
 *
 * @param {string} text
 * @returns {string}
 */
export function contentHash(text) {
  return createHash('sha1').update(text ?? '').digest('hex').slice(0, 10);
}

/**
 * @typedef {object} FileSnap
 * @property {string} path
 * @property {string} hash
 * @property {number} entropy     - bits per byte
 * @property {number} size
 * @property {number} mtime
 * @property {string} kind
 */

/**
 * @typedef {object} CorpusSnapshot
 * @property {number} capturedAt
 * @property {number} count
 * @property {number} totalEntropy  - bits (sum of size × entropy per file)
 * @property {Record<string, FileSnap>} files  - keyed by realPath
 */

/**
 * Build a corpus snapshot from the enumerated artifacts. Cheap; O(N)
 * over body bytes (entropy is one pass per file).
 *
 * @param {Array<{kind: string, realPath: string, body: string}>} artifacts
 * @param {Record<string, number>} [mtimesByPath]
 * @returns {CorpusSnapshot}
 */
export function captureSnapshot(artifacts, mtimesByPath = {}) {
  const files = {};
  let totalEntropy = 0;
  for (const a of artifacts) {
    const entropy = shannonEntropy(a.body);
    const size = a.body?.length ?? 0;
    files[a.realPath] = {
      path: a.realPath,
      kind: a.kind,
      hash: contentHash(a.body),
      entropy,
      size,
      mtime: mtimesByPath[a.realPath] ?? 0,
    };
    totalEntropy += entropy * size;
  }
  return { capturedAt: Date.now(), count: artifacts.length, totalEntropy, files };
}

/**
 * @typedef {object} CorpusDelta
 * @property {string[]} added
 * @property {string[]} removed
 * @property {string[]} changed   - paths where the hash differs
 * @property {number} novelty     - 0..1, fraction-of-corpus shifted
 * @property {number} entropyDelta - |H_curr − H_prev| in bits, summed
 */

/**
 * Diff two snapshots. `novelty` is (added + changed + removed)/max(count)
 * weighted by the entropy per file so a 1-char tweak to a short file
 * counts less than a full rewrite of a long dense one.
 *
 * @param {CorpusSnapshot|null} prev
 * @param {CorpusSnapshot} curr
 * @returns {CorpusDelta}
 */
export function diffSnapshot(prev, curr) {
  if (!prev || !prev.files) {
    const all = Object.keys(curr.files);
    return {
      added: all, removed: [], changed: [],
      novelty: all.length === 0 ? 0 : 1,
      entropyDelta: curr.totalEntropy,
    };
  }
  const added = [], removed = [], changed = [];
  const currPaths = new Set(Object.keys(curr.files));
  const prevPaths = new Set(Object.keys(prev.files));
  for (const p of currPaths) if (!prevPaths.has(p)) added.push(p);
  for (const p of prevPaths) if (!currPaths.has(p)) removed.push(p);
  for (const p of currPaths) {
    if (!prevPaths.has(p)) continue;
    if (prev.files[p].hash !== curr.files[p].hash) changed.push(p);
  }
  // Weighted novelty — each shifted file contributes its own entropy
  // × size, normalized against total current corpus entropy. A single
  // tiny comment-only tweak registers near zero; a whole-skill rewrite
  // registers near its own fraction.
  let weightedShift = 0;
  for (const p of [...added, ...changed]) {
    const f = curr.files[p];
    if (f) weightedShift += f.entropy * f.size;
  }
  for (const p of removed) {
    const f = prev.files[p];
    if (f) weightedShift += f.entropy * f.size;
  }
  const totalMass = Math.max(curr.totalEntropy, prev.totalEntropy, 1);
  const novelty = Math.min(1, weightedShift / totalMass);

  const entropyDelta = Math.abs(curr.totalEntropy - prev.totalEntropy);
  return { added, removed, changed, novelty, entropyDelta };
}
