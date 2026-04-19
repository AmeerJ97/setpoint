#!/usr/bin/env node
/**
 * `setpoint` — dispatch entry point.
 *
 * Default (no args, or statusLine invocation with stdin JSON)
 *   → render the HUD. Matches the Claude Code statusLine contract.
 *
 * Subcommands:
 *   setpoint guard status [--json]
 *     Drilldown of the 17-category enforcement surface.
 *     Exits non-zero when any category has drifted from setpoint.
 *
 *   setpoint health
 *     Run the health auditor once and write health-report.json.
 *
 *   setpoint advisor
 *     Run the daily advisor once and write daily-report.md.
 *
 *   setpoint help | --help | -h
 *     Print this message.
 */

import { main as renderHud } from '../hud/renderer.js';

const [cmd, sub, ...rest] = process.argv.slice(2);

async function run() {
  // No subcommand → render HUD from stdin.
  if (!cmd) {
    await renderHud();
    return 0;
  }

  switch (cmd) {
    case 'guard': {
      if (sub === 'status') {
        const mod = await import('./guard-status.js');
        return mod.main([sub, ...rest]);
      }
      usage(`unknown guard subcommand: ${sub ?? '(none)'}`);
      return 2;
    }
    case 'health': {
      await import('../health/index.js');
      return 0;
    }
    case 'advisor': {
      await import('../advisor/index.js');
      return 0;
    }
    case 'demo': {
      const mod = await import('./demo.js');
      return mod.main();
    }
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      // Unknown first token — treat as statusLine stdin for compat.
      // Claude Code does not pass argv; any stray token here is user error.
      usage(`unknown command: ${cmd}`);
      return 2;
  }
}

function usage(err) {
  if (err) process.stderr.write(`setpoint: ${err}\n\n`);
  process.stdout.write(`\
setpoint — keeps your Claude Code configuration at the values it was meant to have

Usage:
  setpoint                              render HUD (reads Claude Code statusLine JSON on stdin)
  setpoint guard status [--json]        drilldown of the 17-category enforcement surface
  setpoint health                       run the health auditor
  setpoint advisor                      run the daily advisor
  setpoint demo                         render the HUD in every color/glyph mode
  setpoint help                         show this message

Environment:
  CLAUDE_CONFIG_DIR=/path               override ~/.claude
  CLAUDE_HUD_PRICING_FILE=/path.json    override model pricing
  CLAUDE_HUD_DEFAULTS_FILE=/path.json   override full defaults blob
`);
}

run().then(
  code => process.exit(code ?? 0),
  err  => { process.stderr.write(`setpoint: ${err.stack ?? err}\n`); process.exit(1); },
);
