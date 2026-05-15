/**
 * `claude-ops scan` — semantic drilldown of the current session.
 *
 * Two modes:
 *
 *   1. Local (default, always available): runs the in-repo BM25 scorer
 *      from `src/advisor/semantic-engine.js` against the session's
 *      recent tool targets and prints the top N skill-profile matches.
 *      Zero dependencies — uses what's already compiled into claude-ops.
 *
 *   2. qmd bridge (opt-in, requires qmd on PATH):
 *      When `--qmd <collection>` is passed and `qmd` resolves via
 *      `PATH`, we shell out to `qmd query <phrase> -c <collection>
 *      --json -n <limit>` using the same chunk text we'd feed the
 *      local scorer. Results are merged into the output. This gives
 *      you the real vector + LLM-rerank stack without requiring qmd
 *      as a hard dependency. If qmd is missing, we print a clear
 *      "qmd not found" message and still render the local result.
 *
 * Never touches the HUD hotpath — qmd cold-start is fine here because
 * the user asked for it interactively.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR, PROJECTS_DIR } from '../data/paths.js';
import {
  loadProfiles,
  chunk,
  tokenize,
  bm25Score,
} from '../advisor/semantic-engine.js';

const FSM_STATE_FILE = join(PLUGIN_DIR, 'fsm-state.json');
const SEMANTIC_STATE_FILE = join(PLUGIN_DIR, 'semantic-state.json');

/**
 * @param {string[]} argv subcommand args (excluding 'scan')
 */
export async function main(argv = []) {
  const opts = parseArgs(argv);

  if (opts.help) {
    printUsage();
    return 0;
  }

  // 1. Reconstruct the chunk text we'd scan. Prefer the persisted
  // semantic-state tokens (what the last HUD render saw) and fall back
  // to the most recently active session JSONL's tail.
  const chunkText = opts.text ?? readPersistedChunkText() ?? readRecentTranscriptTail();

  if (!chunkText) {
    process.stdout.write('claude-ops scan: no session activity found to scan yet.\n');
    process.stdout.write('  Pass --text "..." to provide a literal phrase, or let the HUD run a few renders first.\n');
    return 2;
  }

  const { beg, end } = chunk(chunkText);
  const queryTokens = tokenize(`${beg} ${end}`);

  // 2. Local BM25 drilldown — always runs.
  const corpus = loadProfiles();
  const local = [];
  if (corpus.N > 0 && queryTokens.size > 0) {
    for (const [name, doc] of corpus.profiles) {
      const score = bm25Score(queryTokens, doc, corpus);
      if (score > 0) local.push({ name, score });
    }
    local.sort((a, b) => b.score - a.score);
  }

  // 3. Optional qmd bridge.
  let qmdResult = null;
  if (opts.qmdCollection) {
    qmdResult = runQmd(opts.qmdCollection, chunkText, opts.limit);
  }

  // 4. FSM state for context.
  const fsm = readFsmSnapshot();

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      fsm,
      queryTokenCount: queryTokens.size,
      chunkLength: chunkText.length,
      local: local.slice(0, opts.limit),
      qmd: qmdResult,
    }, null, 2) + '\n');
    return 0;
  }

  renderHuman({ fsm, local: local.slice(0, opts.limit), qmd: qmdResult, chunkText, queryTokens });
  return 0;
}

export function readPersistedChunkText() {
  try {
    if (!existsSync(SEMANTIC_STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(SEMANTIC_STATE_FILE, 'utf8'));
    if (!Array.isArray(data?.tokens) || data.tokens.length === 0) return null;
    // The persisted shape is token-only (no raw text). For the qmd bridge
    // we still want a phrase — join the tokens with spaces so qmd gets
    // a query it can tokenize.
    return data.tokens.join(' ');
  } catch {
    return null;
  }
}

function readRecentTranscriptTail() {
  // Walk projects/*/**.jsonl, find the most recently modified, grab the
  // tail. Best-effort and read-only.
  try {
    if (!existsSync(PROJECTS_DIR)) return null;
    let newest = null;
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const projDir = join(PROJECTS_DIR, proj);
      let st;
      try { st = statSync(projDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of readdirSync(projDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = join(projDir, f);
        try {
          const fst = statSync(full);
          if (!newest || fst.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: fst.mtimeMs };
        } catch { /* skip */ }
      }
    }
    if (!newest) return null;
    const raw = readFileSync(newest.path, 'utf8');
    const lines = raw.trim().split('\n');
    // Take the last ~50 lines and extract any plain text content.
    const tail = lines.slice(-50);
    const parts = [];
    for (const l of tail) {
      try {
        const e = JSON.parse(l);
        const content = e?.message?.content ?? e?.content ?? '';
        if (typeof content === 'string') parts.push(content);
        else if (Array.isArray(content)) {
          for (const c of content) if (typeof c?.text === 'string') parts.push(c.text);
        }
      } catch { /* skip non-json */ }
    }
    const joined = parts.join(' ');
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}

export function readFsmSnapshot() {
  try {
    if (!existsSync(FSM_STATE_FILE)) return null;
    return JSON.parse(readFileSync(FSM_STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Shell out to qmd when available. Returns a structured object or a
 * clear error message object — never throws. Never runs on the HUD
 * hotpath.
 */
export function runQmd(collection, query, limit) {
  // Resolve qmd via PATH. `spawnSync('qmd', ...)` does that for us and
  // reports ENOENT cleanly if missing.
  const args = ['query', query.slice(0, 1024), '-c', collection, '--json', '-n', String(limit)];
  const res = spawnSync('qmd', args, { encoding: 'utf8', timeout: 30_000 });
  if (res.error && res.error.code === 'ENOENT') {
    return { error: 'qmd not found on PATH — install it or omit --qmd' };
  }
  if (res.status !== 0) {
    return { error: `qmd exited ${res.status}: ${(res.stderr ?? '').trim().slice(0, 200)}` };
  }
  try {
    return { results: JSON.parse(res.stdout) };
  } catch {
    // qmd may emit a non-JSON preamble before the JSON payload; pass
    // through as raw text so the user can still see it.
    return { raw: res.stdout.slice(0, 2000) };
  }
}

export function renderHuman({ fsm, local, qmd, chunkText, queryTokens }) {
  const bar = '─'.repeat(60);
  process.stdout.write(`\nclaude-ops scan\n${bar}\n`);
  if (fsm) {
    process.stdout.write(`  FSM state:    ${fsm.currentState} (thrashing ticks: ${fsm.thrashingTicks ?? 0})\n`);
    if (fsm.lastTransition) {
      const ago = Math.round((Date.now() - fsm.lastTransition.at) / 1000);
      process.stdout.write(`  Last change:  ${fsm.lastTransition.from} → ${fsm.lastTransition.to}  ${ago}s ago\n`);
      process.stdout.write(`                reason: ${fsm.lastTransition.reason}\n`);
    }
  } else {
    process.stdout.write('  FSM state:    (cold start — run the HUD once to seed state)\n');
  }
  process.stdout.write(`  Query size:   ${queryTokens.size} unique tokens from ${chunkText.length} chars\n\n`);

  process.stdout.write('Top in-repo skill-profile matches (BM25):\n');
  if (local.length === 0) {
    process.stdout.write('  (no profile matched — chunk may be too short or unrelated to any hook)\n');
  } else {
    for (const r of local) {
      process.stdout.write(`  ${r.score.toFixed(3).padStart(7)}  ${r.name}\n`);
    }
  }
  process.stdout.write('\n');

  if (qmd) {
    process.stdout.write('qmd bridge:\n');
    if (qmd.error) {
      process.stdout.write(`  ${qmd.error}\n`);
    } else if (qmd.results) {
      const hits = Array.isArray(qmd.results) ? qmd.results
        : Array.isArray(qmd.results?.results) ? qmd.results.results
        : [];
      if (hits.length === 0) {
        process.stdout.write('  (qmd returned 0 hits)\n');
      } else {
        for (const h of hits) {
          const path = h.filepath ?? h.path ?? h.display_path ?? h.docid ?? '(unknown)';
          const score = Number(h.score ?? h.rerank_score ?? 0).toFixed(3);
          process.stdout.write(`  ${score.padStart(7)}  ${path}\n`);
        }
      }
    } else if (qmd.raw) {
      process.stdout.write(`  [raw qmd output]\n${qmd.raw}\n`);
    }
    process.stdout.write('\n');
  }
}

export function parseArgs(argv) {
  const opts = { limit: 5, json: false, qmdCollection: null, text: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--qmd') { opts.qmdCollection = argv[++i]; }
    else if (a === '--text') { opts.text = argv[++i]; }
    else if (a === '-n' || a === '--limit') { opts.limit = Number(argv[++i]) || 5; }
    else if (a === 'scan') { /* leading subcommand token — ignore */ }
  }
  return opts;
}

function printUsage() {
  process.stdout.write(`\
claude-ops scan — semantic drilldown of the current session

Usage:
  claude-ops scan [--json] [-n LIMIT] [--qmd COLLECTION] [--text "..."]

Options:
  --json              emit machine-readable output
  -n, --limit LIMIT   top-N matches to print (default 5)
  --qmd COLLECTION    shell out to qmd query against this collection
                      (requires qmd on PATH; no-op with clear message if missing)
  --text "..."        scan a literal phrase instead of the persisted session tail
  --help              show this message

Input:
  By default the scan uses the semantic state persisted by the last HUD
  render. With no state on disk yet it falls back to the tail of the most
  recently modified transcript at \${CLAUDE_CONFIG_DIR}/projects/.

Examples:
  claude-ops scan
  claude-ops scan --json -n 10
  claude-ops scan --qmd notes
  claude-ops scan --text "refactor the auth middleware"
`);
}
