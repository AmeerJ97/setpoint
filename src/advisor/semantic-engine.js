/**
 * Semantic intent engine — Magika-style fixed-chunk sampling + Okapi BM25.
 *
 * Pattern borrowed from google/magika's `_extract_features_from_seekable`
 * (beginning/end chunk, no sliding window, no middle) and its static
 * content-type knowledge base. We replace Magika's ONNX classifier with
 * pure Okapi BM25 scoring (IDF × tf normalized by document length) against
 * a corpus of "skill profiles" compiled from `config/hooks/*.md`.
 *
 * Why BM25 over plain Jaccard: rare, high-signal tokens like "adversarial"
 * or "compaction" carry more weight than ubiquitous tokens like "edit".
 * Classic Jaccard treats every shared token equally — we want the rare
 * ones to dominate the match. BM25 is the battle-tested IR scoring
 * function for exactly this (conceptually what qmd delegates to SQLite
 * FTS5 for; we implement it in ~40 lines of arithmetic over 8 tiny docs).
 *
 * Zero dependencies, zero network I/O, zero model weights. Suitable for
 * the HUD renderer (runs per one-shot render) and passes the repo's
 * no-production-mocks gate: when profiles are missing, we return an
 * honest empty signal rather than a fallback.
 *
 * Drift is the Jaccard distance between the current chunk token-set and
 * the previous one (persisted to disk so renders across processes can
 * reconstruct it). Higher drift = intent has shifted. We keep Jaccard for
 * drift because it's a symmetric set metric — BM25 is asymmetric and not
 * suitable for "how different are these two chunks".
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHooks } from '../hooks/evaluator.js';
import { PLUGIN_DIR } from '../data/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOOKS_DIR = join(__dirname, '..', '..', 'config', 'hooks');
const SEMANTIC_STATE_FILE = join(PLUGIN_DIR, 'semantic-state.json');

// Magika-style chunk sizes. Magika uses beg=1024 / end=1024 bytes on
// a 4KB block; we work with character-oriented text so we shrink the
// window a little. Small enough to stay well under the hook SLA.
const BEG_SIZE = 512;
const END_SIZE = 512;

// Minimum chunk token-set size before a match is considered stable.
// Below this the score is dominated by noise.
const MIN_TOKENS_FOR_MATCH = 4;

// Okapi BM25 parameters. `k1` controls term-frequency saturation; `b`
// controls length normalization. These are the SQLite FTS5 defaults and
// the Lucene defaults — well-tested across IR tasks.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Hardcoded stopword set — words that carry no intent signal and would
// otherwise pollute every profile's token bag. Kept tiny on purpose.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'to',
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that',
  'these', 'those', 'you', 'your', 'i', 'we', 'our', 'has', 'have',
  'had', 'do', 'does', 'did', 'not', 'so', 'from', 'no',
]);

const TOKEN_RE = /[a-z][a-z0-9_-]+/g;

/**
 * @typedef {object} ProfileDoc
 * @property {Map<string, number>} counts - token → frequency in this profile
 * @property {Set<string>} tokens - unique tokens (for Jaccard-based drift)
 * @property {number} length - total token count (with repeats)
 */

/**
 * @typedef {object} Corpus
 * @property {Map<string, ProfileDoc>} profiles
 * @property {Map<string, number>} df - token → number of profiles containing it
 * @property {number} N - total number of profiles
 * @property {number} avgdl - mean document length
 */

/**
 * Lowercase + regex-split + stopword-filter into a Set (unique tokens).
 * Used for drift (set-symmetric) and as a shortcut when callers don't
 * need frequency.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  if (!text) return new Set();
  const out = new Set();
  const lower = text.toLowerCase();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    const t = m[0];
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * Tokenize into a frequency map (multiset). Needed by BM25 — the scoring
 * function weights repeated terms according to the k1 saturation curve.
 *
 * @param {string} text
 * @returns {{ counts: Map<string, number>, length: number }}
 */
export function tokenCounts(text) {
  const counts = new Map();
  let length = 0;
  if (!text) return { counts, length };
  const lower = text.toLowerCase();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    const t = m[0];
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
    length++;
  }
  return { counts, length };
}

/**
 * Magika-style two-point sampler: leading chunk (after lstrip) and
 * trailing chunk (after rstrip). No middle chunk, matching Magika's
 * current `mid_size=0` default.
 *
 * @param {string} text
 * @returns {{beg: string, end: string}}
 */
export function chunk(text) {
  if (!text) return { beg: '', end: '' };
  const left = text.replace(/^\s+/, '');
  const right = text.replace(/\s+$/, '');
  return {
    beg: left.slice(0, BEG_SIZE),
    end: right.slice(Math.max(0, right.length - END_SIZE)),
  };
}

/**
 * Classic Jaccard: |A ∩ B| / |A ∪ B|. Kept for drift computation — BM25
 * is asymmetric so it's unsuitable for "how much did intent change".
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
export function jaccard(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compile skill profiles from `config/hooks/*.md` into a BM25-ready
 * corpus. Each profile is a multiset over `name + kind + body` using
 * `parseHook()` to get the frontmatter/body split (reuses the hook
 * library's parser — don't reimplement YAML).
 *
 * Honest empty result when no hooks exist: returns an empty corpus.
 *
 * @param {string} [dir]
 * @returns {Corpus}
 */
export function loadProfiles(dir = DEFAULT_HOOKS_DIR) {
  /** @type {Corpus} */
  const corpus = { profiles: new Map(), df: new Map(), N: 0, avgdl: 0 };
  if (!existsSync(dir)) return corpus;
  const hooks = loadHooks(dir);
  let totalLen = 0;
  for (const h of hooks) {
    const text = `${h.name} ${h.kind} ${h.body}`;
    const { counts, length } = tokenCounts(text);
    if (counts.size === 0) continue;
    const tokens = new Set(counts.keys());
    corpus.profiles.set(h.name, { counts, tokens, length });
    totalLen += length;
    // Document-frequency accumulator — each unique token in this profile
    // increments the df counter.
    for (const token of tokens) {
      corpus.df.set(token, (corpus.df.get(token) ?? 0) + 1);
    }
  }
  corpus.N = corpus.profiles.size;
  corpus.avgdl = corpus.N > 0 ? totalLen / corpus.N : 0;
  return corpus;
}

/**
 * Okapi BM25 score of query against a single profile doc. We use the
 * query as a token Set (unweighted, binary presence) — the profile
 * side carries the tf weighting. This is the standard formulation for
 * short queries against longer docs.
 *
 *   score = Σ_{t in Q ∩ D} IDF(t) × (tf(t,D)·(k1+1)) / (tf(t,D) + k1·(1 − b + b·|D|/avgdl))
 *   IDF(t) = ln((N − df(t) + 0.5) / (df(t) + 0.5) + 1)
 *
 * The `+1` in IDF guarantees non-negative scores even for stopword-like
 * tokens; matches SQLite FTS5 and Lucene.
 *
 * @param {Set<string>} query
 * @param {ProfileDoc} doc
 * @param {Corpus} corpus
 * @returns {number}
 */
export function bm25Score(query, doc, corpus) {
  if (!query || query.size === 0 || !doc || doc.length === 0 || corpus.N === 0) return 0;
  const { counts, length } = doc;
  const { df, N, avgdl } = corpus;
  const lenNorm = avgdl > 0 ? (1 - BM25_B + BM25_B * (length / avgdl)) : 1;
  let score = 0;
  for (const t of query) {
    const tf = counts.get(t);
    if (!tf) continue;
    const n = df.get(t) ?? 0;
    // Dampened/shifted IDF (never negative).
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm);
    score += idf * tfNorm;
  }
  return score;
}

/**
 * Argmax BM25 across the profile set. Returns null when either the
 * corpus is empty or the chunk token-set is too small to trust.
 *
 * @param {Set<string>} chunkTokens
 * @param {Corpus} corpus
 * @returns {{name: string, score: number}|null}
 */
export function matchProfile(chunkTokens, corpus) {
  if (!corpus || corpus.N === 0) return null;
  if (!chunkTokens || chunkTokens.size < MIN_TOKENS_FOR_MATCH) return null;
  let best = null;
  for (const [name, doc] of corpus.profiles) {
    const s = bm25Score(chunkTokens, doc, corpus);
    if (s <= 0) continue;
    if (!best || s > best.score) best = { name, score: s };
  }
  return best;
}

/**
 * Drift = 1 − Jaccard(current, previous). When there's no previous
 * chunk to compare against, drift is 0 (first-tick sentinel).
 *
 * @param {Set<string>} current
 * @param {Set<string>|null} previous
 * @returns {number}
 */
export function computeDrift(current, previous) {
  if (!previous || previous.size === 0 || !current || current.size === 0) return 0;
  return Math.max(0, 1 - jaccard(current, previous));
}

/**
 * Load persisted semantic state. Returns `{ tokens, topSkill }`.
 *
 * @param {string} [path]
 * @returns {{ tokens: Set<string>|null, topSkill: string|null }}
 */
export function loadSemanticState(path = SEMANTIC_STATE_FILE) {
  try {
    if (!existsSync(path)) return { tokens: null, topSkill: null };
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    const tokens = Array.isArray(data?.tokens) ? new Set(data.tokens) : null;
    const topSkill = typeof data?.topSkill === 'string' ? data.topSkill : null;
    return { tokens, topSkill };
  } catch {
    return { tokens: null, topSkill: null };
  }
}

/**
 * Persist semantic state atomically. tmp-then-rename to avoid torn
 * writes when two renders race.
 *
 * @param {{ tokens: Set<string>, topSkill: string|null }} state
 * @param {string} [path]
 */
export function saveSemanticState(state, path = SEMANTIC_STATE_FILE) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload = JSON.stringify({
      tokens: Array.from(state.tokens ?? []),
      topSkill: state.topSkill ?? null,
      ts: Date.now(),
    });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
  } catch {
    /* state persistence is best-effort; never fail the render */
  }
}

/**
 * Composed entry point for callers. Takes a text slice, returns the top
 * matching skill profile (if any) and the Jaccard-distance drift vs. the
 * previous tick's chunk tokens. Persists the current chunk tokens so
 * the NEXT tick has a reference point — unless `persist:false` is passed.
 *
 * Honest empty result when nothing to compare / no profiles loaded:
 * `{ topSkill: null, matchScore: 0, drift: 0 }`. No fallback.
 *
 * @param {object} input
 * @param {string} input.text - transcript tail + current prompt
 * @param {Corpus} [input.profiles] - pre-loaded corpus (else loaded)
 * @param {string} [input.statePath] - override persistence path (tests)
 * @param {boolean} [input.persist=true] - disable persistence (tests)
 * @returns {{ topSkill: string|null, matchScore: number, drift: number }}
 */
export function analyzeIntent(input) {
  const { text, profiles: preloaded, statePath = SEMANTIC_STATE_FILE, persist = true } = input ?? {};
  const corpus = preloaded ?? loadProfiles();

  const { beg, end } = chunk(text ?? '');
  const tokens = tokenize(`${beg} ${end}`);

  const previous = loadSemanticState(statePath);
  const drift = computeDrift(tokens, previous.tokens);

  const top = matchProfile(tokens, corpus);
  const topSkill = top?.name ?? null;
  const matchScore = top?.score ?? 0;

  if (persist && tokens.size > 0) {
    saveSemanticState({ tokens, topSkill }, statePath);
  }

  return { topSkill, matchScore, drift };
}
