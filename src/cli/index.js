#!/usr/bin/env node
/**
 * `claude-ops` — dispatch entry point.
 *
 * Default (no args, or statusLine invocation with stdin JSON)
 *   → render the HUD. Matches the Claude Code statusLine contract.
 *
 * Subcommands:
 *   claude-ops guard status [--json]
 *     Drilldown of the docs-backed controls plus internal GrowthBook probes.
 *     Exits non-zero only with --strict when docs-backed controls drift.
 *
 *   claude-ops guard validate [--json] [--strict]
 *     Read-only docs-aligned verifier for official Claude Code controls.
 *
 *   claude-ops health [--json]
 *     Run the health auditor once and write health-report.json.
 *
 *   claude-ops advisor
 *     Run the daily advisor once and write daily-report.md.
 *
 *   claude-ops usage
 *     Summarize the local usage-history ledger.
 *
 *   claude-ops analytics status|start|stop|restart
 *     Inspect or control the on-demand analytics collector.
 *
 *   claude-ops help | --help | -h
 *     Print this message.
 */

import { main as renderHud } from '../hud/renderer.js';

const [cmd, sub, ...rest] = process.argv.slice(2);

async function run() {
  // No subcommand → render HUD from stdin.
  if (!cmd) {
    if (process.stdin.isTTY) {
      usage();
      return 0;
    }
    await renderHud();
    return 0;
  }

  switch (cmd) {
    case 'guard': {
      if (sub === 'status') {
        const mod = await import('./guard-status.js');
        return mod.main([sub, ...rest]);
      }
      if (sub === 'repair') {
        const mod = await import('./guard-repair.js');
        return mod.main([sub, ...rest]);
      }
      if (sub === 'mode') {
        const mod = await import('./guard-mode.js');
        return mod.main([sub, ...rest]);
      }
      if (sub === 'validate') {
        const mod = await import('./guard-validate.js');
        return mod.main([sub, ...rest]);
      }
      usage(`unknown guard subcommand: ${sub ?? '(none)'}`);
      return 2;
    }
    case 'health': {
      const mod = await import('../health/index.js');
      mod.runAllChecks({ json: [sub, ...rest].includes('--json') });
      return 0;
    }
    case 'advisor': {
      if (sub === 'status') {
        const mod = await import('./advisor-status.js');
        return mod.main([sub, ...rest]);
      }
      const mod = await import('../advisor/index.js');
      await mod.generateReport();
      return 0;
    }
    case 'doctor': {
      const mod = await import('./doctor.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'repair': {
      const mod = await import('./repair.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'context': {
      const mod = await import('./context.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'skills': {
      const mod = await import('./skills.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'usage': {
      const mod = await import('./usage.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'analytics': {
      const mod = await import('./analytics.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'telemetry': {
      const mod = await import('./telemetry.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'vertex': {
      const mod = await import('./vertex.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'demo': {
      const mod = await import('./demo.js');
      return mod.main();
    }
    case 'auto-effort': {
      const mod = await import('./auto-effort.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'effort': {
      const mod = await import('./effort.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'scan': {
      const mod = await import('./scan.js');
      return mod.main([sub, ...rest].filter(Boolean));
    }
    case 'consolidate': {
      const mod = await import('./consolidate.js');
      return mod.main([sub, ...rest].filter(Boolean));
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
  if (err) process.stderr.write(`claude-ops: ${err}\n\n`);
  process.stdout.write(`\
claude-ops — operational telemetry, billing awareness, guardrails, and repair tooling for Claude Code

Usage:
  claude-ops                              render the HUD when Claude Code pipes statusLine JSON
  claude-ops help                         show this message

Core:
  claude-ops doctor [--json]              inspect runtime, install, cache, skills, and context pressure
  claude-ops repair [--apply] [--json]    repair local CLI/statusLine/core services
  claude-ops context [--json] [--session|--latest]
                                           approximate the native /context grid
  claude-ops skills status|quarantine|restore
                                           audit or quarantine oversized/broken local skills
  claude-ops usage [--json] [--since 7d]  summarize local usage/cost history

Guard:
  claude-ops guard status [--json]        drilldown of the 17-category enforcement surface
  claude-ops guard mode [audit|enforce|disabled|status]
                                           configure guard enforcement mode
  claude-ops guard repair [--apply]       repair docs-backed guard controls in settings.env
  claude-ops guard validate [--json]      read-only docs-aligned guard verifier

Vertex:
  claude-ops vertex status [--json]       inspect Vertex setup, cache policy, and discovery cache
  claude-ops vertex discover [--json]     sweep available Anthropic Vertex models/regions
  claude-ops vertex use ...               write Vertex project/region/model/cache settings
  claude-ops vertex switch <family>       switch active Claude family (haiku|sonnet|opus)
  claude-ops vertex cache <off|5m|1h>     set prompt caching policy for Claude on Vertex
  claude-ops telemetry vertex collect     collect provider telemetry snapshots outside statusLine

Reports:
  claude-ops health [--json]              run the health auditor
  claude-ops advisor                      run the daily advisor (write daily-report.md)
  claude-ops advisor status [--json]      inspect the live recommendation engine

Session tuning:
  claude-ops auto-effort [on|off|status]  toggle the Opus 4.7 effort auto-swap controller
  claude-ops effort [<level>] [--json]    persist Claude Code effort (low|medium|high|xhigh|default)

Experimental:
  claude-ops scan [--json] [--qmd COLL]   experimental BM25 drilldown + optional qmd bridge
  claude-ops consolidate ...              experimental overlap detection + memory promotion

Environment:
  CLAUDE_CONFIG_DIR=/path               override ~/.claude
  CLAUDE_OPS_CLAUDE_JSON_PATH=/path     override ~/.claude.json
  CLAUDE_OPS_BIN_DIR=/path              override repair/install CLI launcher directory
  CLAUDE_OPS_INSTALL_DIR=/path          override source-checkout install copy directory
  CLAUDE_OPS_GUARD_MODE=audit|enforce|disabled  choose install-time guard mode
  CLAUDE_OPS_SYSTEMD_USER_DIR=/path     override user systemd unit directory
  CLAUDE_OPS_SKIP_SYSTEMCTL=1           install/repair units without systemctl calls
  CLAUDE_OPS_ANALYTICS_POLL_MS=30000    tune analytics collector poll interval
  CLAUDE_OPS_RTK_POLL_MS=300000         tune RTK probe interval
  CLAUDE_OPS_ANALYTICS_IDLE_EXIT_MS=120000 exit collector after idle time
  CLAUDE_OPS_ANALYTICS_START_THROTTLE_MS=60000 throttle HUD wakeups
  CLAUDE_OPS_ANALYTICS_KEEPALIVE=1      keep analytics running continuously
  CLAUDE_OPS_DISABLE_ANALYTICS=1        stop HUD from waking analytics collector
  CLAUDE_OPS_DISABLE_RTK=1              disable RTK probes from analytics collector
  CLAUDE_OPS_PRICING_FILE=/path.json    override model pricing
  CLAUDE_OPS_DEFAULTS_FILE=/path.json   override full defaults blob
  CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE=/path.json  Vertex snapshot path read by HUD
`);
}

run().then(
  code => process.exit(code ?? 0),
  err  => { process.stderr.write(`claude-ops: ${err.stack ?? err}\n`); process.exit(1); },
);
