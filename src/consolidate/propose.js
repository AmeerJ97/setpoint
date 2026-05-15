/**
 * Consolidate — proposal staging.
 *
 * Maintains a single idempotent JSON file listing every pending
 * consolidation action. Rerunning `scan` reconciles the new set with
 * the stored state:
 *   - already-applied proposals stay applied (dropped on next scan)
 *   - pending proposals with identical identity keep their id
 *   - new proposals append with the next monotonic id
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { PLUGIN_DIR } from '../data/paths.js';

export const CONSOLIDATE_DIR = join(PLUGIN_DIR, 'consolidate');
export const PROPOSALS_FILE = join(CONSOLIDATE_DIR, 'proposals.json');
export const AUDIT_FILE     = join(CONSOLIDATE_DIR, 'audit.jsonl');
export const BACKUPS_DIR    = join(CONSOLIDATE_DIR, 'backups');

/**
 * @typedef {object} Proposal
 * @property {string} id
 * @property {'merge_overlap'|'promote_memory'|'delete_orphan'|'rename'} kind
 * @property {number} confidence
 * @property {string[]} sources
 * @property {string} target
 * @property {string} diffPreview
 * @property {object|null} haikuOutput
 * @property {boolean} autoApplyable
 * @property {string} reason
 * @property {'pending'|'applied'|'dismissed'} status
 * @property {string} identity - hash used for idempotence across scans
 * @property {number} createdAt
 */

/**
 * @typedef {object} ProposalStore
 * @property {string} generatedAt
 * @property {Record<string, number>} sources
 * @property {Proposal[]} proposals
 */

/**
 * Identity hash for a proposal. Two scans that surface the same logical
 * action produce the same identity, which lets us dedup across reruns
 * without losing user review progress.
 *
 * @param {Omit<Proposal,'id'|'createdAt'|'status'|'identity'>} p
 * @returns {string}
 */
export function identity(p) {
  const key = JSON.stringify({ kind: p.kind, sources: [...p.sources].sort(), target: p.target });
  return createHash('sha1').update(key).digest('hex').slice(0, 10);
}

/**
 * @returns {ProposalStore}
 */
export function loadStore() {
  if (!existsSync(PROPOSALS_FILE)) return { generatedAt: '', sources: {}, proposals: [] };
  try {
    const raw = readFileSync(PROPOSALS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.proposals)) return { generatedAt: '', sources: {}, proposals: [] };
    return data;
  } catch {
    return { generatedAt: '', sources: {}, proposals: [] };
  }
}

/**
 * @param {ProposalStore} store
 */
export function saveStore(store) {
  mkdirSync(dirname(PROPOSALS_FILE), { recursive: true });
  const tmp = `${PROPOSALS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, PROPOSALS_FILE);
}

/**
 * Reconcile a freshly-computed set of proposals with the persisted
 * store. Rules:
 *   - An old proposal that matches a new one by identity keeps its
 *     id + status (applied / dismissed stay that way).
 *   - An old `pending` proposal that doesn't appear in the new set
 *     is dropped.
 *   - An old `applied` or `dismissed` proposal is retained as a
 *     tombstone for audit, even if it no longer appears.
 *   - A new proposal that didn't exist before gets a fresh monotonic
 *     id and `status: 'pending'`.
 *
 * @param {Array<Omit<Proposal,'id'|'createdAt'|'status'|'identity'>>} fresh
 * @param {Record<string,number>} sourceCounts
 * @param {ProposalStore} [prev=loadStore()]
 * @returns {ProposalStore}
 */
export function reconcile(fresh, sourceCounts, prev = loadStore()) {
  const byIdentity = new Map();
  for (const p of prev.proposals) {
    if (p.identity) byIdentity.set(p.identity, p);
  }

  let maxId = prev.proposals.reduce((m, p) => {
    const n = parseInt((p.id ?? '').replace(/^prop-/, ''), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);

  const freshIdentities = new Set();
  const merged = [];

  for (const f of fresh) {
    const id = identity(f);
    freshIdentities.add(id);
    const existing = byIdentity.get(id);
    if (existing) {
      merged.push({ ...existing, ...f, identity: id, id: existing.id, status: existing.status, createdAt: existing.createdAt });
    } else {
      maxId++;
      merged.push({
        ...f,
        identity: id,
        id: `prop-${String(maxId).padStart(4, '0')}`,
        status: 'pending',
        createdAt: Date.now(),
      });
    }
  }

  // Retain tombstones for already-applied/dismissed entries even when
  // they no longer surface.
  for (const p of prev.proposals) {
    if ((p.status === 'applied' || p.status === 'dismissed') && !freshIdentities.has(p.identity)) {
      merged.push(p);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    sources: sourceCounts,
    proposals: merged,
  };
}

/**
 * Mark a proposal applied (or dismissed). Pure — returns a new store;
 * caller persists.
 *
 * @param {ProposalStore} store
 * @param {string} id
 * @param {'applied'|'dismissed'} status
 * @returns {ProposalStore}
 */
export function markStatus(store, id, status) {
  return {
    ...store,
    proposals: store.proposals.map(p => p.id === id ? { ...p, status } : p),
  };
}
