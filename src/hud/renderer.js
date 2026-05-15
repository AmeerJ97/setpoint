#!/usr/bin/env node
/**
 * Claude Ops — HUD orchestration entry point.
 * Claude Code invokes this per render cycle: pipes JSON to stdin, reads stdout.
 */

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { readStdin } from '../data/stdin.js';
import { render } from '../display/renderer.js';
import { buildRenderContext } from './pipeline.js';
import { kickAnalyticsDaemon, maybeWriteHistory, analyticsKickDue } from './effects.js';

async function main() {
  try {
    const stdin = await readStdin();

    if (!stdin) {
      console.log('[claude-ops] No Claude Code statusLine JSON received. Run `claude-ops --help` for CLI commands.');
      return;
    }

    kickAnalyticsDaemon();

    const cycle = await buildRenderContext(stdin, { env: process.env });
    render(cycle.ctx);

    maybeWriteHistory(
      cycle.sessionId,
      cycle.usageData,
      cycle.tokenStats,
      cycle.advisory,
      cycle.effort,
      stdin,
      cycle.rtkStats,
      cycle.runtimeMode,
      cycle.vertexTelemetry,
      cycle.ctx.billingUsage,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : null;
    console.error(`[claude-ops] Error: ${message}`);
    if (stack) console.error(stack);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};

if (argvPath && isSamePath(argvPath, scriptPath)) {
  await main();
}

export { main, analyticsKickDue };
