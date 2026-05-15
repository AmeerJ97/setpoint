/**
 * Scan gate — decides whether to run the expensive BM25 + Haiku
 * passes or skip with a "nothing meaningfully changed" signal.
 *
 * Persists a small `gate-state.json` alongside proposals.json holding:
 *   - Last corpus snapshot (from entropy.js).
 *   - Cached tool-availability probes (qmd / claude) with TTL.
 *
 * Caching the probes is the point the user raised: `spawnSync('qmd',
 * ['--version'])` was firing on every render. Now it runs at most once
 * per `PROBE_TTL_MS` per tool, and the result is reused.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONSOLIDATE_DIR } from './propose.js';
import { captureSnapshot, diffSnapshot } from './entropy.js';

const GATE_FILE = join(CONSOLIDATE_DIR, 'gate-state.json');

/** 10-minute TTL for probe caching. */
const PROBE_TTL_MS = 10 * 60 * 1000;

/** Default novelty threshold — below this we skip a full scan. */
const DEFAULT_NOVELTY_THRESHOLD = 0.02;

/**
 * @typedef {object} GateState
 * @property {import('./entropy.js').CorpusSnapshot|null} snapshot
 * @property {{ [tool: string]: { ok: boolean, at: number } }} probes
 * @property {number} lastScanAt
 */

/** @returns {GateState} */
export function loadGateState() {
  try {
    if (!existsSync(GATE_FILE)) return { snapshot: null, probes: {}, lastScanAt: 0 };
    const data = JSON.parse(readFileSync(GATE_FILE, 'utf8'));
    return { snapshot: data.snapshot ?? null, probes: data.probes ?? {}, lastScanAt: data.lastScanAt ?? 0 };
  } catch {
    return { snapshot: null, probes: {}, lastScanAt: 0 };
  }
}

/** @param {GateState} state */
export function saveGateState(state) {
  try {
    mkdirSync(dirname(GATE_FILE), { recursive: true });
    const tmp = `${GATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, GATE_FILE);
  } catch { /* best-effort */ }
}

/**
 * Compute the scan decision. Returns the delta + a bool `skip` that
 * the caller honors unless the user passed `--force`.
 *
 * @param {object} input
 * @param {Array<{kind: string, realPath: string, body: string}>} input.artifacts
 * @param {Record<string, number>} [input.mtimes]
 * @param {number} [input.threshold=DEFAULT_NOVELTY_THRESHOLD]
 * @param {GateState} [input.state]
 * @returns {{
 *   skip: boolean,
 *   reason: string,
 *   snapshot: import('./entropy.js').CorpusSnapshot,
 *   delta: import('./entropy.js').CorpusDelta,
 *   state: GateState,
 * }}
 */
export function decideScan(input) {
  const { artifacts, mtimes = {}, threshold = DEFAULT_NOVELTY_THRESHOLD } = input;
  const state = input.state ?? loadGateState();
  const snapshot = captureSnapshot(artifacts, mtimes);
  const delta = diffSnapshot(state.snapshot, snapshot);
  const isFirstRun = !state.snapshot;
  const hasChurn = delta.added.length + delta.removed.length + delta.changed.length > 0;

  let skip = false;
  let reason;
  if (isFirstRun) {
    reason = `first run — ${snapshot.count} artifacts`;
  } else if (!hasChurn) {
    skip = true;
    reason = 'no files changed since last scan';
  } else if (delta.novelty < threshold) {
    skip = true;
    reason = `novelty ${delta.novelty.toFixed(4)} < threshold ${threshold} — ${delta.added.length}+${delta.changed.length}+${delta.removed.length} paths below significance`;
  } else {
    reason = `novelty ${delta.novelty.toFixed(3)} (${delta.added.length} added, ${delta.changed.length} changed, ${delta.removed.length} removed)`;
  }

  return { skip, reason, snapshot, delta, state };
}

/**
 * Cached probe for an external CLI tool. Returns `{ ok, cached }`.
 * Probe fn must return a boolean.
 *
 * @param {string} tool
 * @param {() => boolean} probeFn
 * @param {GateState} state
 * @param {number} [ttlMs=PROBE_TTL_MS]
 * @returns {{ ok: boolean, cached: boolean }}
 */
export function cachedProbe(tool, probeFn, state, ttlMs = PROBE_TTL_MS) {
  const rec = state.probes[tool];
  const now = Date.now();
  if (rec && typeof rec.ok === 'boolean' && now - rec.at < ttlMs) {
    return { ok: rec.ok, cached: true };
  }
  const ok = !!probeFn();
  state.probes[tool] = { ok, at: now };
  return { ok, cached: false };
}
