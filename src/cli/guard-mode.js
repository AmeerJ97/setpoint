#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configureGuardMode } from '../guard/mode-control.js';

export function main(argv = process.argv.slice(2), options = {}) {
  const json = argv.includes('--json');
  const filtered = argv.filter(arg => arg !== '--json');
  const action = filtered[1] ?? 'status';
  const result = configureGuardMode(action, options.env ?? process.env);
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderGuardModeResult(result));
  return result.ok ? 0 : 1;
}

export function renderGuardModeResult(result) {
  if (result.error) return `claude-ops guard mode: ${result.error}\n`;
  const guard = result.guard ?? {};
  const lines = [
    `claude-ops guard mode: ${guard.mode ?? result.requestedMode}`,
    `service: active=${guard.active ?? 'unknown'} enabled=${guard.enabled ?? 'unknown'} disabled=${guard.disabled ? 'yes' : 'no'}`,
    `detail: ${result.detail ?? guard.detail ?? 'ok'}`,
  ];
  return `${lines.join('\n')}\n`;
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
