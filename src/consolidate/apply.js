/**
 * Consolidate — apply + undo with safety rails.
 *
 * Every mutation:
 *   1. Validates the target is under an allowed source root (no path
 *      escape outside `~/.claude/`).
 *   2. Copies existing files to a timestamped backup dir BEFORE any
 *      write, preserving the relative tree.
 *   3. Writes atomically (tmp-then-rename).
 *   4. Appends an audit line to audit.jsonl.
 *
 * `undo(ts)` reverses a single backup generation by copying the bak
 * tree back in place.
 */

import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  copyFileSync, unlinkSync, readdirSync, statSync, realpathSync,
} from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { CONSOLIDATE_DIR, AUDIT_FILE, BACKUPS_DIR, loadStore, saveStore, markStatus } from './propose.js';
import { DEFAULT_ROOTS } from './sources.js';
import { getClaudeConfigDir } from '../data/paths.js';

/**
 * Allowed roots a consolidate apply may write inside.
 *
 * Whitelists BOTH the configured path and its realpath so dotfiles-
 * symlinked skills dirs (the common case: `~/.claude/skills` →
 * `/home/<user>/dev/dotfiles/...`) aren't rejected. Without this,
 * every valid apply was failing because `enumerate()` returns
 * realpath-resolved targets while the sandbox only knew the symlink.
 */
function allowedRoots() {
  const claudeDir = currentClaudeDir();
  const raw = [
    DEFAULT_ROOTS.skills,
    DEFAULT_ROOTS.commands,
    DEFAULT_ROOTS.agents,
    DEFAULT_ROOTS.memoryGlobal,
    DEFAULT_ROOTS.projectsDir,
    join(claudeDir, 'skills'),
    join(claudeDir, 'commands'),
    join(claudeDir, 'agents'),
    join(claudeDir, 'MEMORY.md'),
    join(claudeDir, 'projects'),
  ];
  const out = new Set();
  for (const p of raw) {
    const abs = resolve(p);
    out.add(abs);
    try { out.add(realpathSync(abs)); } catch { /* root may not exist yet */ }
  }
  return [...out];
}

function isPathAllowed(target) {
  const abs = resolve(target);
  // Parent-dir realpath covers new artifacts (leaf doesn't exist yet).
  let real = abs;
  try {
    real = join(realpathSync(dirname(abs)), abs.slice(dirname(abs).length + 1));
  } catch { /* parent doesn't exist */ }
  const roots = allowedRoots();
  return roots.some(root =>
    abs === root || abs.startsWith(root + '/')
    || real === root || real.startsWith(root + '/')
  );
}

/**
 * Apply a single proposal by id.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {boolean} [opts.yes=false] - bypass interactive confirm
 * @returns {{ ok: boolean, reason: string, bakDir?: string }}
 */
export function applyProposal(id, opts = {}) {
  const store = loadStore();
  const p = store.proposals.find(x => x.id === id);
  if (!p) return { ok: false, reason: 'proposal not found' };
  if (p.status !== 'pending') return { ok: false, reason: `proposal already ${p.status}` };
  if (!isPathAllowed(p.target)) return { ok: false, reason: 'target path outside allowed roots' };
  for (const s of p.sources) {
    if (!isPathAllowed(s)) return { ok: false, reason: `source path outside allowed roots: ${s}` };
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bakDir = join(BACKUPS_DIR, ts);
  mkdirSync(bakDir, { recursive: true });

  // Backup every file we might touch (target + all sources).
  const toBackup = new Set([p.target, ...p.sources]);
  for (const file of toBackup) {
    if (!existsSync(file)) continue;
    const rel = safeBackupRelativePath(file);
    const dst = join(bakDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    try { copyFileSync(file, dst); } catch { /* best-effort */ }
  }

  // Execute per kind.
  let bytes = 0;
  try {
    switch (p.kind) {
      case 'merge_overlap': {
        const body = p.haikuOutput?.body;
        if (typeof body !== 'string' || body.length === 0) {
          return { ok: false, reason: 'merge_overlap requires haikuOutput.body' };
        }
        atomicWrite(p.target, body);
        bytes = body.length;
        // Delete superseded sources (excluding the target itself).
        for (const s of p.sources) {
          if (resolve(s) === resolve(p.target)) continue;
          try { unlinkSync(s); } catch { /* already gone */ }
        }
        break;
      }
      case 'promote_memory': {
        const body = p.haikuOutput?.cleaned_body ?? p.haikuOutput?.cleanedBody;
        if (typeof body !== 'string' || body.length === 0) {
          return { ok: false, reason: 'promote_memory requires haikuOutput.cleaned_body' };
        }
        atomicWrite(p.target, body);
        bytes = body.length;
        // Optionally remove replaced sources.
        for (const s of p.haikuOutput?.replaces ?? []) {
          if (resolve(s) === resolve(p.target)) continue;
          if (!isPathAllowed(s)) continue;
          try { unlinkSync(s); } catch { /* already gone */ }
        }
        break;
      }
      case 'rename': {
        // sources[0] → target
        const src = p.sources[0];
        if (!src || !existsSync(src)) return { ok: false, reason: 'rename source missing' };
        mkdirSync(dirname(p.target), { recursive: true });
        renameSync(src, p.target);
        bytes = statSync(p.target).size;
        break;
      }
      case 'delete_orphan': {
        for (const s of p.sources) {
          if (!isPathAllowed(s)) continue;
          try { unlinkSync(s); } catch { /* already gone */ }
        }
        break;
      }
      default:
        return { ok: false, reason: `unknown kind: ${p.kind}` };
    }
  } catch (err) {
    return { ok: false, reason: `write failed: ${err.message}` };
  }

  appendAudit({
    ts: Date.now(), id: p.id, kind: p.kind, sources: p.sources, target: p.target,
    bytesWritten: bytes, bakDir,
  });
  saveStore(markStatus(store, id, 'applied'));
  return { ok: true, reason: 'applied', bakDir };
}

/**
 * Restore the most recent backup (or a specific ts).
 *
 * @param {{ ts?: string, last?: boolean }} opts
 * @returns {{ ok: boolean, reason: string, restored?: number }}
 */
export function undo(opts = {}) {
  if (!existsSync(BACKUPS_DIR)) return { ok: false, reason: 'no backups dir' };
  const entries = readdirSync(BACKUPS_DIR).filter(e => existsSync(join(BACKUPS_DIR, e)));
  if (entries.length === 0) return { ok: false, reason: 'no backups found' };
  let pick;
  if (opts.ts) pick = opts.ts;
  else pick = entries.sort().pop();
  const bakDir = join(BACKUPS_DIR, pick);
  if (!existsSync(bakDir)) return { ok: false, reason: `backup ${pick} not found` };
  let count = 0;
  walkFiles(bakDir, (abs) => {
    const rel = relative(bakDir, abs);
    const target = join(resolve(currentClaudeDir()), rel);
    if (!isPathAllowed(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(abs, target);
    count++;
  });
  return { ok: true, reason: `restored ${count} file(s) from ${pick}`, restored: count };
}

function safeBackupRelativePath(file) {
  const abs = resolve(file);
  const claude = resolve(currentClaudeDir());
  if (abs === claude || abs.startsWith(claude + '/')) {
    return relative(claude, abs);
  }
  const relHome = relative(homedir(), abs);
  if (relHome.startsWith('..')) return `external/${abs.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  return relHome;
}

function currentClaudeDir() {
  return getClaudeConfigDir(homedir());
}

function atomicWrite(target, body) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, target);
}

function appendAudit(entry) {
  mkdirSync(CONSOLIDATE_DIR, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  // node fs doesn't have appendSync atomicity, but the entry fits in
  // one write() syscall so torn writes aren't a practical concern.
  writeFileSync(AUDIT_FILE, line, { flag: 'a' });
}

function walkFiles(dir, fn) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, fn);
    else if (st.isFile()) fn(full);
  }
}
