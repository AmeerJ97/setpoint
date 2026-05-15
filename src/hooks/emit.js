#!/usr/bin/env node
/**
 * Claude Code hook shim — stdouts a UserPromptSubmit
 * `hookSpecificOutput.additionalContext` JSON blob when the evaluator
 * picks a hook that wants to fire right now,
 * otherwise silent (so Claude Code sees no hook output).
 *
 * The Claude Code hook runtime provides session context on stdin and
 * expects one JSON object on stdout. We read the current HUD metrics
 * from the daemon-written per-session cache; the evaluator decides;
 * the emitted body is substituted with current metric values.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHooks, selectHook, recordFire, renderBody } from './evaluator.js';
import { readCachedTokenStatsMeta } from '../collectors/session-scanner.js';
import { PLUGIN_DIR } from '../data/paths.js';
import { getHookDefaults } from '../data/defaults.js';

async function main() {
  let stdin = '';
  try {
    stdin = await readStdin();
  } catch { /* no stdin input — use empty */ }

  let event = {};
  try { event = stdin ? JSON.parse(stdin) : {}; } catch { /* malformed */ }

  const eventName = event.hook_event_name
    ?? event.hookEventName
    ?? event.event
    ?? 'UserPromptSubmit';

  maybeWritePreCompactSnapshot(eventName, event);

  const sessionId = event.session_id ?? null;
  const meta = readCachedTokenStatsMeta(sessionId);
  const stats = meta.data ?? {};

  // Metrics shape the hook frontmatter triggers expect — match the
  // `stem` names the evaluator derives (e.g. `context_above` → `context`).
  const metrics = {
    context: Number(event.context_percent ?? 0),
    ratio: computeRatio(stats),
    edits: countEdits(stats),
    reads: countReads(stats),
    edits_this_turn: Number(event.edits_this_turn ?? 0),
    reads_this_turn: Number(event.reads_this_turn ?? 0),
    edits_session: countEdits(stats),
    task_updates_session: Number(event.task_updates_session ?? 0),
    lr_risk: Number(event.lr_risk ?? 0),
    mcp_loaded: Number(event.mcp_loaded ?? 0),
    mcp_used: Number(event.mcp_used ?? 0),
    agent_spawns_session: Number(stats.agentSpawns ?? 0),
    tte_5h_sec: Number(event.tte_5h_sec ?? Infinity),
    // Display-friendly aliases the bodies use with {placeholder} substitution:
    mcp_loaded_count: Number(event.mcp_loaded ?? 0),
    mcp_used_count: Number(event.mcp_used ?? 0),
    agent_spawns: Number(stats.agentSpawns ?? 0),
  };

  const hook = selectHook(metrics, loadHooks());
  if (!hook) return;  // silent — Claude Code proceeds as normal

  const body = renderBody(hook.body, metrics);
  recordFire(hook, metrics);
  process.stdout.write(JSON.stringify(formatHookOutput({ eventName, body })) + '\n');
}

export function formatUserPromptSubmitOutput(body) {
  return formatHookOutput({ eventName: 'UserPromptSubmit', body, mode: 'advisory' });
}

export function formatHookOutput({ eventName = 'UserPromptSubmit', body, mode = resolveHookMode() }) {
  if (mode === 'blocking') {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        decision: 'block',
        reason: body,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: body,
    },
  };
}

function resolveHookMode(env = process.env) {
  if (env.CLAUDE_OPS_HOOK_MODE === 'blocking') return 'blocking';
  if (env.CLAUDE_OPS_HOOK_MODE === 'advisory') return 'advisory';
  return getHookDefaults().mode;
}

function maybeWritePreCompactSnapshot(eventName, event, env = process.env) {
  if (eventName !== 'PreCompact') return;
  const enabled = env.CLAUDE_OPS_PRECOMPACT_SNAPSHOTS === '1'
    || getHookDefaults().preCompactSnapshots;
  if (!enabled) return;
  try {
    const dir = join(PLUGIN_DIR, 'precompact');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const session = String(event.session_id ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    writeFileSync(join(dir, `${stamp}.${session}.json`), JSON.stringify({
      ts: new Date().toISOString(),
      session_id: event.session_id ?? null,
      transcript_path: event.transcript_path ?? event.stop_hook_active_transcript_path ?? null,
      trigger: event.trigger ?? event.matcher ?? null,
      compact_metadata: event.compact_metadata ?? null,
    }, null, 2));
  } catch { /* non-critical */ }
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    // fallback timeout — hooks run under a wall-clock budget
    setTimeout(() => resolve(data), 500);
  });
}

function countReads(stats) {
  return Number((stats.tools?.Read ?? 0) + (stats.tools?.Grep ?? 0) + (stats.tools?.Glob ?? 0));
}
function countEdits(stats) {
  return Number((stats.tools?.Edit ?? 0) + (stats.tools?.Write ?? 0) + (stats.tools?.MultiEdit ?? 0));
}
function computeRatio(stats) {
  const r = countReads(stats), e = countEdits(stats);
  if (e === 0) return r > 0 ? 20 : 0;
  return r / e;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};

if (argvPath && isSamePath(argvPath, scriptPath)) {
  main().catch((err) => {
    console.error(`[claude-ops] Hook emitter error: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
