/**
 * Consolidate — source enumeration.
 *
 * Walks ~/.claude/{skills,commands,agents} and any projects memory/ dirs
 * under ~/.claude/projects/, returning a flat list of artifact records.
 * Follows symlinks (the user's skills dir is typically a symlink into
 * claude-dotfiles) so we get the real paths for later diffing.
 *
 * Each record: { kind, path, realPath, body, frontmatter }
 *   kind = 'skill' | 'command' | 'agent' | 'memory_global' | 'memory_project'
 */

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseHook } from '../hooks/evaluator.js';
import { getClaudeConfigDir } from '../data/paths.js';

const CLAUDE = getClaudeConfigDir();

export const DEFAULT_ROOTS = {
  skills:   join(CLAUDE, 'skills'),
  commands: join(CLAUDE, 'commands'),
  agents:   join(CLAUDE, 'agents'),
  memoryGlobal:  join(CLAUDE, 'MEMORY.md'),
  projectsDir:   join(CLAUDE, 'projects'),
};

const DEFAULT_KINDS = ['skills', 'commands', 'agents', 'memory'];

/**
 * Path substrings excluded by default. Attic mirrors and dated
 * snapshots pair every origin skill with its own snapshot, burying
 * real overlap signal under noise. Opt out with `noDefaultExcludes`.
 */
const DEFAULT_EXCLUDES = [
  '_consolidation/',
  'attic-proposed/',
  '/snapshot-',
  '/dropped/',
  '/.git/',
  'node_modules/',
];

/**
 * @typedef {object} Artifact
 * @property {'skill'|'command'|'agent'|'memory_global'|'memory_project'} kind
 * @property {string} path         - logical path (as Claude Code sees it)
 * @property {string} realPath     - realpath (symlink-resolved)
 * @property {string} body         - full file contents
 * @property {object|null} frontmatter - parsed YAML frontmatter when present
 */

/**
 * Enumerate every candidate artifact for the given kinds, filtered by
 * --exclude glob-ish patterns (substring match; we deliberately don't
 * pull in a glob lib).
 *
 * @param {object} [opts]
 * @param {string[]} [opts.kinds=DEFAULT_KINDS] - which source buckets to include
 * @param {string[]} [opts.excludes=[]]         - substring patterns to drop
 * @param {object}   [opts.roots=DEFAULT_ROOTS] - overrides for tests
 * @returns {Artifact[]}
 */
export function enumerate(opts = {}) {
  const kinds = opts.kinds ?? DEFAULT_KINDS;
  const excludes = opts.noDefaultExcludes
    ? (opts.excludes ?? [])
    : [...DEFAULT_EXCLUDES, ...(opts.excludes ?? [])];
  const roots = { ...DEFAULT_ROOTS, ...(opts.roots ?? {}) };
  const out = [];

  const addIf = (rec) => {
    if (!rec) return;
    if (excludes.some(p => rec.path.includes(p))) return;
    out.push(rec);
  };

  if (kinds.includes('skills') && existsSync(roots.skills)) {
    for (const dir of safeReaddir(roots.skills)) {
      const dirPath = join(roots.skills, dir);
      const st = safeStat(dirPath);
      if (!st?.isDirectory()) continue;
      for (const f of walkMd(dirPath)) {
        addIf(readArtifact('skill', f));
      }
    }
  }

  if (kinds.includes('commands') && existsSync(roots.commands)) {
    for (const f of flatMd(roots.commands)) {
      addIf(readArtifact('command', f));
    }
  }

  if (kinds.includes('agents') && existsSync(roots.agents)) {
    for (const f of flatMd(roots.agents)) {
      addIf(readArtifact('agent', f));
    }
  }

  if (kinds.includes('memory')) {
    if (existsSync(roots.memoryGlobal)) {
      addIf(readArtifact('memory_global', roots.memoryGlobal));
    }
    if (existsSync(roots.projectsDir)) {
      for (const proj of safeReaddir(roots.projectsDir)) {
        const memDir = join(roots.projectsDir, proj, 'memory');
        if (!existsSync(memDir)) continue;
        for (const f of flatMd(memDir)) {
          addIf(readArtifact('memory_project', f));
        }
      }
    }
  }

  return out;
}

function readArtifact(kind, path) {
  const real = safeRealpath(path);
  const body = safeRead(path);
  if (body === null) return null;
  let frontmatter = null;
  if (body.startsWith('---')) {
    const parsed = parseHook(body);
    if (parsed) frontmatter = { name: parsed.name, kind: parsed.kind, priority: parsed.priority };
  }
  return { kind, path, realPath: real ?? path, body, frontmatter };
}

function walkMd(dir) {
  const out = [];
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry);
    const st = safeStat(full);
    if (!st) continue;
    if (st.isDirectory()) out.push(...walkMd(full));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function flatMd(dir) {
  const out = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.md')) continue;
    out.push(join(dir, entry));
  }
  return out;
}

function safeReaddir(d) { try { return readdirSync(d); } catch { return []; } }
function safeStat(p)    { try { return statSync(p);    } catch { return null; } }
function safeRead(p)    { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function safeRealpath(p){ try { return realpathSync(p); } catch { return p; } }

/**
 * Group an artifact list by kind — convenience for reporting.
 *
 * @param {Artifact[]} artifacts
 * @returns {Record<string, number>}
 */
export function countByKind(artifacts) {
  const out = { skill: 0, command: 0, agent: 0, memory_global: 0, memory_project: 0 };
  for (const a of artifacts) out[a.kind] = (out[a.kind] ?? 0) + 1;
  return out;
}
