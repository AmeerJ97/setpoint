#!/usr/bin/env node
/**
 * Health auditor — periodic scanner for ~/.claude/ health.
 * Writes JSON report to ~/.claude/plugins/claude-hud/health-report.json.
 */
import { writeJsonAtomic } from '../data/jsonl.js';
import { HEALTH_REPORT_FILE } from '../data/paths.js';
import { checkSessionBloat } from './checks/session-bloat.js';
import { checkDiskUsage } from './checks/disk-usage.js';
import { checkConfigDrift } from './checks/config-drift.js';
import { checkOrphanFiles } from './checks/orphan-files.js';
import { checkClaudeMdAccumulation } from './checks/claudemd-accumulation.js';
import { checkFlagCoverage } from './checks/flag-coverage.js';

function runAllChecks() {
  const issues = [
    ...checkSessionBloat(),
    ...checkDiskUsage(),
    ...checkConfigDrift(),
    ...checkOrphanFiles(),
    ...checkClaudeMdAccumulation(),
    ...checkFlagCoverage(),
  ];

  const report = {
    generatedAt: new Date().toISOString(),
    issueCount: issues.filter(i => i.severity !== 'info').length,
    issues,
  };

  writeJsonAtomic(HEALTH_REPORT_FILE, report);
  console.log(`[health-auditor] ${issues.length} checks, ${report.issueCount} issues found`);
  return report;
}

// Run if invoked directly
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
if (argvPath) {
  try { if (realpathSync(argvPath) === realpathSync(scriptPath)) runAllChecks(); }
  catch { if (argvPath === scriptPath) runAllChecks(); }
}

export { runAllChecks };
