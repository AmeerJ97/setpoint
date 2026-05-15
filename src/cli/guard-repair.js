#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaudeConfigDir } from '../data/paths.js';
import { collectGuardValidationState } from '../guard/guard-validation.js';

const REPAIR_VALUES = Object.freeze({
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000',
  CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '500000',
  MAX_MCP_OUTPUT_TOKENS: '500000',
  ENABLE_PROMPT_CACHING_1H: '1',
  DISABLE_PROMPT_CACHING: '0',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
});

export function main(argv = process.argv.slice(2), options = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(helpText());
    return 0;
  }

  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const result = repairGuardControls({
    apply,
    env: options.env ?? process.env,
    settingsPath: options.settingsPath,
  });

  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderRepairResult(result));
  return apply && !result.ok ? 1 : 0;
}

export function repairGuardControls({ apply = false, env = process.env, settingsPath } = {}) {
  const path = settingsPath ?? join(getClaudeConfigDir(), 'settings.json');
  const before = collectGuardValidationState(env, { settingsPath: path });
  const operations = buildOperations(before);
  const repairable = operations.filter(op => op.status === 'repairable');
  let changed = false;

  if (apply && repairable.length > 0) {
    const settings = readJson(path) ?? {};
    const nextEnv = settings.env && typeof settings.env === 'object' ? { ...settings.env } : {};
    for (const op of repairable) nextEnv[op.name] = op.desiredValue;
    mkdirSync(dirname(path), { recursive: true });
    backupIfExists(path);
    settings.env = nextEnv;
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
    changed = true;
  }

  const after = apply ? collectGuardValidationState(env, { settingsPath: path }) : before;
  return {
    ok: apply ? after.summary.controls.drift === 0 : true,
    applied: apply,
    changed,
    settingsPath: path,
    before: summarizeValidation(before),
    after: summarizeValidation(after),
    summary: summarizeOperations(operations),
    operations,
  };
}

function buildOperations(state) {
  return (state.controls ?? [])
    .filter(control => control.state === 'drift')
    .map(control => {
      const desiredValue = REPAIR_VALUES[control.name] ?? null;
      if (!desiredValue) {
        return {
          category: control.category,
          name: control.name,
          source: control.source,
          status: 'unsupported',
          desiredValue: null,
          reason: 'docs-backed drift has no automatic repair value',
        };
      }
      return {
        category: control.category,
        name: control.name,
        source: control.source,
        status: 'repairable',
        desiredValue,
        reason: control.source === 'absent' ? 'missing from settings.env' : 'settings.env drift',
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function summarizeValidation(state) {
  return {
    driftControls: state.summary.controls.drift,
    heldControls: state.summary.controls.held,
    infoControls: state.summary.controls.info,
  };
}

function summarizeOperations(operations) {
  return {
    repairable: operations.filter(op => op.status === 'repairable').length,
    blockedEnv: operations.filter(op => op.status === 'blocked-env').length,
    unsupported: operations.filter(op => op.status === 'unsupported').length,
  };
}

function renderRepairResult(result) {
  const lines = [];
  lines.push('claude-ops guard repair');
  lines.push(`settings: ${result.settingsPath}`);
  lines.push(`before: ${result.before.driftControls} official drift`);
  if (result.operations.length === 0) {
    lines.push(result.applied ? 'result: nothing to change' : 'result: no repairable drift');
    return `${lines.join('\n')}\n`;
  }
  lines.push('');
  for (const op of result.operations) {
    const desired = op.desiredValue ? ` -> ${JSON.stringify(op.desiredValue)}` : '';
    lines.push(`${op.status.padEnd(11)} ${op.category}/${op.name}${desired} (${op.reason})`);
  }
  lines.push('');
  if (!result.applied) {
    lines.push('apply: claude-ops guard repair --apply');
  } else {
    lines.push(`after: ${result.after.driftControls} official drift`);
    lines.push(`result: ${result.ok ? 'ok' : 'remaining drift'}`);
  }
  return `${lines.join('\n')}\n`;
}

function backupIfExists(path) {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(path, `${path}.bak.${stamp}`);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function helpText() {
  return `claude-ops guard repair

Usage:
  claude-ops guard repair [--apply] [--json]

Dry-run by default. With --apply, writes docs-backed guard control defaults into
settings.json env values when that is sufficient to clear official drift.
`;
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main());
}
