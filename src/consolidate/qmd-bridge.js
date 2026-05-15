/**
 * Consolidate — qmd sidecar bridge.
 *
 * Optional. Heavily mitigated. Every subprocess launched through this
 * module is wrapped to cap thread count and drop scheduling priority
 * because qmd's default embed/vsearch loads a GGUF model on every core
 * with no nice level, which can pin the CPU and trigger thermal
 * throttling on marginal cooling.
 *
 * Guardrails (applied unconditionally to every qmd spawn):
 *   - OMP_NUM_THREADS / MKL_NUM_THREADS / OPENBLAS_NUM_THREADS /
 *     NUMEXPR_NUM_THREADS / TOKENIZERS_PARALLELISM cap at 2 threads.
 *   - `nice -n 19 ionice -c3` wrapper so the process runs at idle
 *     scheduling priority. Falls back to plain qmd if `nice`/`ionice`
 *     aren't on PATH.
 *   - Aggressive timeouts: probe 5s, collection-add 15s, update 30s,
 *     embed 60s, vsearch 10s. Previous values were too permissive.
 *
 * The `--qmd` CLI flag itself is separately hard-gated behind
 * CLAUDE_OPS_QMD_DANGEROUS_ENABLE=1 so these guardrails only run when
 * the user has explicitly opted in.
 */

import { spawnSync } from 'node:child_process';

const THREAD_CAP = process.env.CLAUDE_OPS_QMD_THREADS ?? '2';

/**
 * Build the subprocess env with aggressive thread caps. Every embedding
 * / tokenizer library we've seen respects at least one of these — set
 * them all so we don't have to know which one qmd's embedder uses.
 */
function capEnv() {
  return {
    ...process.env,
    OMP_NUM_THREADS:       THREAD_CAP,
    MKL_NUM_THREADS:       THREAD_CAP,
    OPENBLAS_NUM_THREADS:  THREAD_CAP,
    NUMEXPR_NUM_THREADS:   THREAD_CAP,
    VECLIB_MAXIMUM_THREADS: THREAD_CAP,
    TOKENIZERS_PARALLELISM: 'false',
    LLAMA_THREADS:         THREAD_CAP,  // node-llama-cpp honors this
  };
}

/**
 * Invoke qmd with scheduling priority dropped to idle. Prefer
 * `ionice -c3 nice -n 19 qmd ...` when both are available; fall back
 * gracefully otherwise. Returns the same spawnSync result shape as the
 * direct call would.
 */
function spawnNiced(args, opts) {
  const env = { ...(opts?.env ?? {}), ...capEnv() };
  const merged = { ...opts, env };
  // Chain `ionice -c3 nice -n 19 qmd <args>`. If either wrapper is
  // missing the outer spawn fails fast and we retry with the inner.
  const wrappers = [
    ['ionice', ['-c3', 'nice', '-n', '19', 'qmd', ...args]],
    ['nice',   ['-n', '19', 'qmd', ...args]],
    ['qmd',    args],
  ];
  for (const [cmd, argv] of wrappers) {
    const r = spawnSync(cmd, argv, merged);
    // ENOENT on the wrapper → try the next fallback. ENOENT on qmd
    // itself surfaces normally.
    if (r.error && r.error.code === 'ENOENT' && cmd !== 'qmd') continue;
    return r;
  }
  return { error: new Error('no spawn path succeeded'), status: null };
}

/**
 * @returns {boolean} true when qmd is resolvable on PATH
 */
export function qmdAvailable() {
  // --version is a bare CLI check; skip the wrapper chain. Does not
  // load any model or spawn any heavy work. Timeout deliberately short.
  const r = spawnSync('qmd', ['--version'], { encoding: 'utf8', timeout: 3_000 });
  if (r.error && r.error.code === 'ENOENT') return false;
  return r.status === 0;
}

/**
 * Idempotent `qmd collection add <path> --name <name>`. Swallows the
 * "already exists" error class so reruns are free.
 *
 * @param {string} name
 * @param {string} path
 * @returns {{ ok: boolean, reason: string }}
 */
export function ensureCollection(name, path) {
  const r = spawnNiced(['collection', 'add', path, '--name', name], { encoding: 'utf8', timeout: 10_000 });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'qmd-missing' };
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`.toLowerCase();
  if (r.status === 0) return { ok: true, reason: 'added' };
  if (combined.includes('already') || combined.includes('exists')) return { ok: true, reason: 'exists' };
  return { ok: false, reason: combined.trim().slice(0, 200) };
}

/**
 * Refresh all collections + regenerate embeddings.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function refresh() {
  // `qmd update` is file-scan + hashing; bounded, not particularly hot.
  const up = spawnNiced(['update'], { encoding: 'utf8', timeout: 30_000 });
  if (up.error && up.error.code === 'ENOENT') return { ok: false, reason: 'qmd-missing' };
  // `qmd embed` is the expensive one — runs a GGUF model on every
  // new/changed file. Hard-capped at 60s under idle scheduling; if
  // that's not enough the corpus is too large to embed interactively
  // and the user should precompute via the qmd CLI directly.
  const em = spawnNiced(['embed'], { encoding: 'utf8', timeout: 60_000 });
  if (em.error && em.error.code === 'ETIMEDOUT') {
    return { ok: false, reason: 'embed-timed-out (60s cap); precompute with `qmd embed` outside the scan loop' };
  }
  if (em.status !== 0 && em.status !== null) {
    return { ok: false, reason: (em.stderr ?? '').trim().slice(0, 200) };
  }
  return { ok: true, reason: 'refreshed' };
}

/**
 * Vector-search nearest neighbors for a given query string. When
 * `collection` is supplied, scope to that collection; otherwise qmd
 * searches across every registered collection (useful for cross-kind
 * overlap detection — a skill and a command might cover the same
 * territory).
 *
 * @param {string} query
 * @param {string|null} [collection]
 * @param {number} [k=5]
 * @returns {{path: string, score: number}[]}
 */
export function neighbors(query, collection = null, k = 5) {
  // Cap the query — long tool-level payloads slow qmd down for no gain.
  const clipped = (query ?? '').slice(0, 2000);
  const args = ['vsearch', clipped, '--json', '-n', String(k)];
  if (collection) args.push('-c', collection);
  const r = spawnNiced(args, { encoding: 'utf8', timeout: 10_000 });
  if (r.error || r.status !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    const hits = Array.isArray(parsed) ? parsed
      : Array.isArray(parsed?.results) ? parsed.results
      : Array.isArray(parsed?.hits) ? parsed.hits
      : [];
    return hits.map(h => ({
      path: h.filepath ?? h.path ?? h.display_path ?? h.docid ?? '',
      score: Number(h.score ?? h.similarity ?? h.distance ?? 0),
    })).filter(h => h.path);
  } catch {
    return [];
  }
}

/**
 * Build a neighborsFn-style callback for cluster.clusterByNeighbors.
 * Returns null when qmd produces zero hits for the artifact — callers
 * treat that as "fall back to BM25 for this one" rather than "isolate".
 *
 * @param {object} [opts]
 * @param {number} [opts.k=5]
 * @param {number} [opts.snippetChars=500] - leading bytes used as the query
 * @returns {(a: {body: string, realPath: string}) => {path: string, score: number}[] | null}
 */
export function makeQmdNeighborsFn({ k = 5, snippetChars = 500 } = {}) {
  return (a) => {
    // Use the leading characters as the vsearch query. Full-body
    // queries can overwhelm qmd's tokenizer and the intent is captured
    // by the opening paragraph on almost every artifact we care about.
    const q = (a.body ?? '').slice(0, snippetChars);
    if (!q) return null;
    const hits = neighbors(q, null, k + 1); // +1 so we can drop the self-hit
    const filtered = hits.filter(h => h.path !== a.realPath && h.path !== a.path);
    return filtered.length ? filtered : null;
  };
}
