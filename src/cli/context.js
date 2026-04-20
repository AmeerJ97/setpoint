/**
 * `setpoint context` — replicates the native /context grid.
 *
 * Native /context (Claude Code 2.1.111+) is interactive-only — there is
 * no `--print`, no `--context` flag, no JSON dump. The only way to see
 * what's eating your context window from outside the TUI is to compute
 * the breakdown ourselves. We're explicit that this is approximate (see
 * src/context/buckets.js) — for budgeting and "where did my tokens go"
 * questions it's accurate enough; for hard accounting, type /context.
 *
 * Usage:
 *   setpoint context [--session <id>] [--json] [--cwd <dir>]
 *
 *   --session <id>   Bucket a specific session (defaults to the most
 *                    recently active one for the current cwd).
 *   --json           Emit the bucket report as JSON instead of the grid.
 *   --cwd <dir>      Override the project dir for agent/memory walks
 *                    (useful when invoking from outside a project).
 */

import { findActiveSessions, findSessionJsonl } from '../data/session.js';
import { buildBucketReport } from '../context/buckets.js';
import { renderGrid } from '../context/grid.js';

/**
 * @param {string[]} argv  argv after the `context` token
 * @returns {Promise<number>} exit code
 */
export async function main(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const cwd = args.cwd ?? process.cwd();
  const sessionInfo = resolveSession(args.session, cwd);
  if (!sessionInfo) {
    process.stderr.write(`setpoint context: no session JSONL found${args.session ? ` for ${args.session}` : ''}\n`);
    process.stderr.write('hint: open a Claude Code session in this directory first, or pass --session <id>\n');
    return 1;
  }

  const report = buildBucketReport({
    transcriptPath: sessionInfo.path,
    cwd,
    contextWindow: 200_000,
    modelLabel: sessionInfo.modelLabel ?? 'unknown',
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return 0;
  }

  const cols = process.stdout.columns ?? 80;
  process.stdout.write(renderGrid(report, cols));
  return 0;
}

function parseArgs(argv) {
  const out = { help: false, json: false, session: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--session':
        out.session = argv[++i];
        break;
      case '--cwd':
        out.cwd = argv[++i];
        break;
      default:
        // Positional or unknown — treat as session id for ergonomics.
        if (!a.startsWith('-') && !out.session) out.session = a;
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`\
setpoint context — bucket the active session's context window

Usage:
  setpoint context [--session <id>] [--json] [--cwd <dir>]

Options:
  --session <id>   Specific session id (default: most recent active session)
  --json           JSON output instead of the rendered grid
  --cwd <dir>      Override project dir for agent/memory walks
  -h, --help       Show this help

Notes:
  This is an approximation of Claude Code's interactive /context grid.
  Bucket sizes for built-in tools are calibrated baselines, not measured
  per-session — the native /context is authoritative when accuracy matters.
`);
}

/**
 * Resolve the session to bucket. If the user passed an id, look it up.
 * Otherwise pick the most recently active session whose cwd matches the
 * current working directory; fall back to the most recent session overall.
 *
 * @param {string|null} explicitId
 * @param {string} cwd
 * @returns {{ path: string, sessionId: string, modelLabel?: string }|null}
 */
function resolveSession(explicitId, cwd) {
  if (explicitId) {
    const found = findSessionJsonl(explicitId);
    return found ? { path: found.path, sessionId: explicitId } : null;
  }

  // Active sessions are ranked by liveness; prefer ones rooted in `cwd`.
  const active = findActiveSessions();
  if (active.length === 0) {
    return null;
  }
  const matchingCwd = active.find(s => s.cwd && cwd.startsWith(s.cwd));
  const chosen = matchingCwd ?? active[active.length - 1];
  const found = findSessionJsonl(chosen.sessionId);
  if (!found) return null;
  return { path: found.path, sessionId: chosen.sessionId };
}
