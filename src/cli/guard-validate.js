#!/usr/bin/env node
/**
 * `claude-ops guard validate` — read-only, docs-aligned guard verifier.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectGuardValidationState } from '../guard/guard-validation.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

export function main(argv = process.argv.slice(2), options = {}) {
  const json = argv.includes('--json');
  const strict = argv.includes('--strict');
  const state = collectGuardValidationState(options.env ?? process.env, options);
  process.stdout.write(json ? `${JSON.stringify(state, null, 2)}\n` : renderValidationTable(state));
  return strict && state.summary.controls.drift > 0 ? 1 : 0;
}

export function renderValidationTable(state) {
  const lines = [];
  lines.push(`${BOLD}claude-ops guard validate${RESET}`);
  lines.push('');
  lines.push(`posture: ${state.posture}`);
  lines.push(`settings: ${state.settings.exists ? state.settings.path : 'not found'}`);
  lines.push('');
  lines.push(`${BOLD}STATE     CATEGORY        AUTHORITY              CONTROL${RESET}`);
  for (const cat of state.categories) {
    const color = stateColor(cat.state);
    const stateCell = `${color}${cat.state.padEnd(8)}${RESET}`;
    lines.push(`${stateCell}  ${cat.category.padEnd(14)}  ${cat.authority.padEnd(21)}  ${cat.claim}`);
    for (const c of cat.officialControls) {
      const cColor = stateColor(c.state);
      const source = c.present ? `${c.source}=${formatValue(c.value)}` : 'absent';
      const expected = c.expected ? ` want ${c.expected}` : ' info';
      lines.push(`    ${cColor}${c.state.padEnd(8)}${RESET} ${c.name} ${DIM}${source};${expected}${RESET}`);
    }
  }
  const v = state.vertexConfig;
  if (v.configured || v.active) {
    const color = stateColor(v.state);
    lines.push('');
    lines.push(`${color}${String(v.state).padEnd(8)}${RESET}  ${'vertex_env'.padEnd(14)}  ${DIM}${'audit-only'.padEnd(21)}${RESET}  ${v.detail}`);
  }
  lines.push('');
  lines.push(`${BOLD}Summary:${RESET} `
    + `${GREEN}${state.summary.controls.held} official held${RESET}, `
    + `${state.summary.controls.drift > 0 ? RED : DIM}${state.summary.controls.drift} official drift${RESET}, `
    + `${YELLOW}${state.summary.categories.internalOnly} internal-only${RESET}`);
  return `${lines.join('\n')}\n`;
}

function stateColor(state) {
  if (state === 'held') return GREEN;
  if (state === 'drift') return RED;
  if (state === 'internal-only' || state === 'disabled') return YELLOW;
  return DIM;
}

function formatValue(value) {
  if (value === undefined || value === null) return '(unset)';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
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
