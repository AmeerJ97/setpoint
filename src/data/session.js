import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
