/**
 * Git status collector. Ported from old HUD git.ts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * @typedef {object} GitStatus
 * @property {string} branch
 * @property {boolean} isDirty
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * @param {string} [cwd]
 * @returns {Promise<GitStatus|null>}
 */
export async function getGitStatus(cwd) {
  if (!cwd) return null;

  try {
    const { stdout: branchOut } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 1000, encoding: 'utf8' }
    );
    const branch = branchOut.trim();
    if (!branch) return null;

    let isDirty = false;
    try {
      const { stdout: statusOut } = await execFileAsync(
        'git', ['--no-optional-locks', 'status', '--porcelain'],
        { cwd, timeout: 1000, encoding: 'utf8' }
      );
      isDirty = statusOut.trim().length > 0;
    } catch {
      // assume clean
    }

    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: revOut } = await execFileAsync(
        'git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        { cwd, timeout: 1000, encoding: 'utf8' }
      );
      const parts = revOut.trim().split(/\s+/);
      if (parts.length === 2) {
        behind = parseInt(parts[0], 10) || 0;
        ahead = parseInt(parts[1], 10) || 0;
      }
    } catch {
      // no upstream
    }

    return { branch, isDirty, ahead, behind };
  } catch {
    return null;
  }
}
