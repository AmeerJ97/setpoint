/**
 * `claude-ops auto-effort [on|off|status]` — opt-in toggle for the
 * context-milestone effort auto-swap controller.
 *
 * on     — create the sentinel file so the HUD will write settings
 * off    — delete the sentinel file (controller is pure no-op)
 * status — print current state + last 10 swap records
 *
 * The controller itself is in src/advisor/effort-controller.js and
 * runs from src/hud/renderer.js on every render. This CLI only
 * touches the enabled flag and surfaces the audit log.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_DIR } from '../data/paths.js';
import { readRecentSwaps, readLastSwap } from '../advisor/effort-writer.js';

const SENTINEL = join(PLUGIN_DIR, 'auto-effort.enabled');

export function main(args = []) {
  const sub = args[0] ?? 'status';
  switch (sub) {
    case 'on':     return enable();
    case 'off':    return disable();
    case 'status': return status(args.includes('--json'));
    default:
      process.stderr.write(`claude-ops auto-effort: unknown subcommand '${sub}'\n`);
      process.stderr.write(`Usage: claude-ops auto-effort [on|off|status]\n`);
      return 2;
  }
}

function enable() {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(SENTINEL, new Date().toISOString() + '\n');
  process.stdout.write(`auto-effort: ENABLED (sentinel at ${SENTINEL})\n`);
  process.stdout.write(`The HUD will now swap effortLevel between xhigh / high / medium\n`);
  process.stdout.write(`based on context % + burn rate + R:E. Opus 4.7 only.\n`);
  return 0;
}

function disable() {
  if (existsSync(SENTINEL)) unlinkSync(SENTINEL);
  process.stdout.write(`auto-effort: DISABLED\n`);
  return 0;
}

function status(asJson) {
  const enabled = existsSync(SENTINEL) || process.env.CLAUDE_OPS_AUTO_EFFORT === '1';
  const last = readLastSwap();
  const recent = readRecentSwaps(10);

  if (asJson) {
    process.stdout.write(JSON.stringify({ enabled, lastSwap: last, recent }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(`auto-effort: ${enabled ? 'ENABLED' : 'DISABLED'}\n`);
  if (last) {
    const ago = humanAgo(last.ts);
    process.stdout.write(`last swap:   ${last.previous ?? '??'} → ${last.target} (${ago}, ${last.reason})\n`);
  } else {
    process.stdout.write(`last swap:   (never)\n`);
  }
  process.stdout.write(`\nrecent swaps (newest first):\n`);
  if (recent.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const r of recent) {
      const ago = humanAgo(r.ts);
      const from = r.previous ?? '??';
      process.stdout.write(`  ${ago.padEnd(10)} ${from} → ${r.target.padEnd(6)} ${r.reason}\n`);
    }
  }
  return 0;
}

function humanAgo(ts) {
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
