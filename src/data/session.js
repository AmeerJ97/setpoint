import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR, PROJECTS_DIR } from './paths.js';

/**
 * @typedef {object} ActiveSession
 * @property {string} sessionId
 * @property {number} pid
 * @property {string} [cwd]
 */

/**
 * Find all active Claude Code sessions by checking PID liveness.
 * @returns {ActiveSession[]}
 */
export function findActiveSessions() {
  const sessions = [];
  try {
    if (!existsSync(SESSIONS_DIR)) return sessions;
    for (const f of readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8'));
        if (data.pid && data.sessionId) {
          try {
            process.kill(data.pid, 0); // check if alive
            sessions.push(data);
          } catch {
            // PID not alive, skip
          }
        }
      } catch {
        // skip malformed
      }
    }
  } catch {
    // SESSIONS_DIR inaccessible
  }
  return sessions;
}

/**
 * Find the JSONL transcript path for a session ID.
 * @param {string} sessionId
 * @returns {{ path: string, project: string }|null}
 */
export function findSessionJsonl(sessionId) {
  try {
    if (!existsSync(PROJECTS_DIR)) return null;
    for (const projDir of readdirSync(PROJECTS_DIR)) {
      const p = join(PROJECTS_DIR, projDir, `${sessionId}.jsonl`);
      if (existsSync(p)) {
        return {
          path: p,
          project: projDir.replace(/^-/, '').replace(/-/g, '/'),
        };
      }
    }
  } catch {
    // PROJECTS_DIR inaccessible
  }
  return null;
}

/**
 * Find the newest session JSONL, preferring the current cwd's project slug
 * when possible. Used as a fallback when active-session metadata is stale.
 *
 * @param {string} [cwd]
 * @returns {{ path: string, project: string }|null}
 */
export function findLatestSessionJsonl(cwd = process.cwd()) {
  try {
    if (!existsSync(PROJECTS_DIR)) return null;
    const preferred = projectSlug(cwd);
    const candidates = [];
    for (const projEntry of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!projEntry.isDirectory()) continue;
      const projDir = projEntry.name;
      const dir = join(PROJECTS_DIR, projDir);
      for (const name of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const path = join(dir, name);
        const stat = safeStat(path);
        if (!stat) continue;
        candidates.push({
          path,
          project: projDir.replace(/^-/, '').replace(/-/g, '/'),
          projectDir: projDir,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const preferA = a.projectDir === preferred ? 1 : 0;
      const preferB = b.projectDir === preferred ? 1 : 0;
      return preferB - preferA || b.mtimeMs - a.mtimeMs;
    });
    return { path: candidates[0].path, project: candidates[0].project };
  } catch {
    return null;
  }
}

function safeStat(path) {
  try { return statSync(path); }
  catch { return null; }
}

function projectSlug(cwd) {
  return String(cwd || '')
    .replace(/[\\/]+/g, '-')
    .replace(/^-+/, '-');
}
