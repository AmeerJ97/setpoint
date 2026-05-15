/**
 * `claude-ops effort [level]` — persist Claude Code effort to settings.json.
 *
 * Claude Code's `/effort <level>` slash command is session-only — it
 * does not write to settings.json, so Claude Ops HUD (which reads
 * settings.json) keeps showing the previously persisted value. This
 * subcommand makes the choice persistent.
 *
 * Subcommands:
 *   claude-ops effort                 → print current persisted level
 *   claude-ops effort <level>         → write level to settings.json
 *   claude-ops effort --json          → JSON status
 *
 * Persisted levels: low | medium | high | xhigh | default
 * Runtime-only level: max via CLAUDE_CODE_EFFORT_LEVEL=max
 */

import { readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../data/jsonl.js';
import { getClaudeConfigDir } from '../data/paths.js';

const VALID_LEVELS = ['low', 'medium', 'high', 'xhigh', 'default'];
const SETTINGS_PATH = join(getClaudeConfigDir(), 'settings.json');

export function main(args = []) {
  const asJson = args.includes('--json');
  const positional = args.filter(a => !a.startsWith('--'));
  const level = positional[0];

  // No arg → status
  if (!level) {
    return printStatus(asJson);
  }

  if (level === 'help' || level === '--help' || level === '-h') {
    printUsage();
    return 0;
  }

  const lower = level.toLowerCase();
  if (!VALID_LEVELS.includes(lower)) {
    process.stderr.write(`claude-ops effort: invalid level '${level}'\n`);
    process.stderr.write(`Valid: ${VALID_LEVELS.join(' | ')}\n`);
    return 2;
  }

  return setLevel(lower, asJson);
}

function printStatus(asJson) {
  const settings = readSettings();
  const current = settings?.effortLevel ?? null;
  const hookMode = readHookMode(settings);
  if (asJson) {
    process.stdout.write(JSON.stringify({
      effortLevel: current,
      sessionEffortLevel: readSessionEffort(),
      validLevels: VALID_LEVELS,
      hookMode,
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`current effortLevel: ${current ?? '(unset)'}\n`);
  const session = readSessionEffort();
  if (session) process.stdout.write(`session effort override: ${session}\n`);
  process.stdout.write(`hook mode: ${hookMode}\n`);
  process.stdout.write(`\nValid levels: ${VALID_LEVELS.join(' | ')}\n`);
  process.stdout.write(`Set with: claude-ops effort <level>\n`);
  return 0;
}

function setLevel(level, asJson) {
  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    // One-time daily backup so a manual rollback is always one cp away.
    const dayStamp = new Date().toISOString().slice(0, 10);
    const backup = `${SETTINGS_PATH}.claude-ops-effort.${dayStamp}.bak`;
    if (!existsSync(backup)) {
      try { copyFileSync(SETTINGS_PATH, backup); } catch { /* ignore */ }
    }
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  }
  const previous = settings.effortLevel ?? null;
  if (level === 'default') delete settings.effortLevel;
  else settings.effortLevel = level;
  writeJsonAtomic(SETTINGS_PATH, settings);

  if (asJson) {
    process.stdout.write(JSON.stringify({
      ok: true,
      previous,
      current: level === 'default' ? null : level,
      hookMode: readHookMode(settings),
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`effortLevel: ${previous ?? '(unset)'} → ${level === 'default' ? '(unset)' : level}\n`);
  return 0;
}

function readCurrent() {
  const settings = readSettings();
  return settings?.effortLevel ?? null;
}

function readSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) return null;
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readSessionEffort() {
  const env = process.env.CLAUDE_CODE_EFFORT_LEVEL
    ?? process.env.CLAUDE_CODE_EFFORT
    ?? process.env.ANTHROPIC_EFFORT
    ?? process.env.EFFORT;
  return env ? String(env).toLowerCase() : null;
}

function readHookMode(settings = null) {
  const explicit = process.env.CLAUDE_OPS_HOOK_MODE
    ?? settings?.claudeOps?.hookMode;
  if (explicit === 'advisory' || explicit === 'blocking') return explicit;
  return 'blocking';
}

function printUsage() {
  process.stdout.write(`\
claude-ops effort — persist Claude Code effort to settings.json

Usage:
  claude-ops effort                 print current persisted level
  claude-ops effort <level>         write level to settings.json
  claude-ops effort --json          JSON status

Levels: ${VALID_LEVELS.join(' | ')}

Notes:
  The current Claude Code docs treat max as a runtime/session level.
  Use CLAUDE_CODE_EFFORT_LEVEL=max when you need it; Claude Ops does not
  persist max into settings.json.
`);
}
