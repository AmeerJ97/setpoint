#!/usr/bin/env node
/**
 * Health auditor — periodic scanner for ~/.claude/ health.
 * Writes JSON report to ~/.claude/plugins/claude-ops/health-report.json.
 */
import { writeJsonAtomic } from '../data/jsonl.js';
import { HEALTH_REPORT_FILE } from '../data/paths.js';
import { checkSessionBloat } from './checks/session-bloat.js';
import { checkDiskUsage } from './checks/disk-usage.js';
import { checkConfigDrift } from './checks/config-drift.js';
import { checkOrphanFiles } from './checks/orphan-files.js';
import { checkClaudeMdAccumulation } from './checks/claudemd-accumulation.js';
import { checkFlagCoverage } from './checks/flag-coverage.js';
import { checkPluginCacheStaleness } from './checks/plugin-cache-staleness.js';
import { checkMcpAudit } from './checks/mcp-audit.js';
import { checkGuardDrift } from './checks/guard-drift.js';

function runAllChecks({ json = false } = {}) {
  const issues = [
    ...checkSessionBloat(),
    ...checkDiskUsage(),
    ...checkConfigDrift(),
    ...checkOrphanFiles(),
    ...checkClaudeMdAccumulation(),
    ...checkFlagCoverage(),
    ...checkPluginCacheStaleness(),
    ...checkMcpAudit(),
    ...checkGuardDrift(),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    issueCount: issues.filter(i => i.severity !== 'info').length,
    issues,
  };

  writeJsonAtomic(HEALTH_REPORT_FILE, report);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHealthReport(report).join('\n'));
  }
  return report;
}

function formatHealthReport(report, reportPath = HEALTH_REPORT_FILE) {
  const actionable = report.issues.filter(i => i.severity !== 'info');
  const infoCount = report.issues.length - actionable.length;
  const lines = [
    `[health-auditor] ${plural(report.issueCount, 'issue')} found, ${plural(infoCount, 'info check')}; report: ${reportPath}`,
  ];

  if (actionable.length === 0) {
    lines.push('[health-auditor] no warnings or errors');
    return lines;
  }

  for (const issue of actionable.slice(0, 10)) {
    lines.push(`${issue.severity} ${issue.check}: ${issue.message}`);
  }
  if (actionable.length > 10) {
    lines.push(`... ${actionable.length - 10} more in ${reportPath}`);
  }
  return lines;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Run if invoked directly
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
if (argvPath) {
  const opts = { json: process.argv.includes('--json') };
  try { if (realpathSync(argvPath) === realpathSync(scriptPath)) runAllChecks(opts); }
  catch { if (argvPath === scriptPath) runAllChecks(opts); }
}

export { runAllChecks, formatHealthReport };
