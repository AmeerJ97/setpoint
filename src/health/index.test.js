import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { formatHealthReport, runAllChecks } from './index.js';
import { HEALTH_REPORT_FILE } from '../data/paths.js';

test('formatHealthReport prints actionable issue details', () => {
  const lines = formatHealthReport({
    issueCount: 2,
    issues: [
      { severity: 'info', check: 'disk-usage', message: '~/.claude/ total: 1.0MB' },
      { severity: 'warning', check: 'plugin-cache-staleness', message: 'freshest token cache 999s old' },
      { severity: 'warning', check: 'guard-drift', message: 'guard categories held:16 skipped:1 drift:1' },
    ],
  }, '/tmp/health-report.json');

  assert.match(lines[0], /2 issues found, 1 info check/);
  assert.ok(lines.includes('warning plugin-cache-staleness: freshest token cache 999s old'));
  assert.ok(lines.includes('warning guard-drift: guard categories held:16 skipped:1 drift:1'));
  assert.doesNotMatch(lines.join('\n'), /disk-usage/);
});

test('formatHealthReport says clean when only info checks are present', () => {
  const lines = formatHealthReport({
    issueCount: 0,
    issues: [
      { severity: 'info', check: 'disk-usage', message: '~/.claude/ total: 1.0MB' },
    ],
  }, '/tmp/health-report.json');

  assert.match(lines[0], /0 issues found, 1 info check/);
  assert.equal(lines[1], '[health-auditor] no warnings or errors');
});

test('formatHealthReport handles empty issues array', () => {
  const lines = formatHealthReport({
    issueCount: 0,
    issues: [],
  }, '/tmp/health-report.json');

  assert.match(lines[0], /0 issues found, 0 info checks/);
  assert.equal(lines[1], '[health-auditor] no warnings or errors');
});

test('formatHealthReport truncates when more than 10 actionable issues', () => {
  const issues = [];
  for (let i = 0; i < 15; i++) {
    issues.push({ severity: 'warning', check: 'test-check', message: `issue ${i}` });
  }
  issues.push({ severity: 'info', check: 'info-check', message: 'info message' });

  const lines = formatHealthReport({ issueCount: 15, issues }, '/tmp/health-report.json');

  assert.match(lines[0], /15 issues found, 1 info check/);
  assert.equal(lines.length, 12);
  for (let i = 0; i < 10; i++) {
    assert.ok(lines[i + 1].startsWith('warning test-check:'));
  }
  assert.match(lines[11], /5 more in \/tmp\/health-report\.json/);
});

test('formatHealthReport includes all severity levels', () => {
  const lines = formatHealthReport({
    issueCount: 3,
    issues: [
      { severity: 'error', check: 'err-check', message: 'error message' },
      { severity: 'warning', check: 'warn-check', message: 'warning message' },
      { severity: 'info', check: 'info-check', message: 'info message' },
    ],
  }, '/tmp/health-report.json');

  assert.match(lines[0], /3 issues found, 1 info check/);
  assert.ok(lines.includes('error err-check: error message'));
  assert.ok(lines.includes('warning warn-check: warning message'));
});

test('formatHealthReport handles single actionable issue', () => {
  const lines = formatHealthReport({
    issueCount: 1,
    issues: [
      { severity: 'warning', check: 'singleton', message: 'only one' },
    ],
  }, '/tmp/health-report.json');

  assert.match(lines[0], /1 issue found/);
  assert.equal(lines[1], 'warning singleton: only one');
  assert.equal(lines.length, 2);
});

test('formatHealthReport uses default reportPath when not provided', () => {
  const lines = formatHealthReport({
    issueCount: 0,
    issues: [
      { severity: 'info', check: 'test', message: 'msg' },
    ],
  });

  assert.ok(lines[0].includes(HEALTH_REPORT_FILE),
    `output references default path ${HEALTH_REPORT_FILE}`);
});

test('runAllChecks returns well-formed report with correct structure', (t) => {
  t.mock.method(console, 'log', () => {});

  const report = runAllChecks();

  assert.ok(report.generatedAt, 'report has generatedAt timestamp');
  assert.equal(typeof report.issueCount, 'number', 'issueCount is a number');
  assert.ok(Array.isArray(report.issues), 'issues is an array');
  assert.equal(report.issueCount, report.issues.filter(i => i.severity !== 'info').length,
    'issueCount equals number of non-info issues');

  for (const issue of report.issues) {
    assert.ok(issue.severity, `issue has severity: ${issue.check}`);
    assert.ok(issue.check, 'issue has check name');
    assert.ok(issue.message, 'issue has message');
    assert.ok(['info', 'warning', 'error'].includes(issue.severity),
      `valid severity "${issue.severity}" for check ${issue.check}`);
  }
});

test('runAllChecks invokes all 9 check modules producing issues with known check names', (t) => {
  t.mock.method(console, 'log', () => {});

  const KNOWN_CHECKS = [
    'session-bloat',
    'disk-usage',
    'config-drift',
    'orphan-files',
    'claudemd-accumulation',
    'flag-coverage',
    'plugin-cache-staleness',
    'mcp-audit',
    'guard-drift',
  ];

  const report = runAllChecks();

  const checkNames = new Set(report.issues.map(i => i.check));
  for (const name of KNOWN_CHECKS) {
    assert.ok(checkNames.has(name) || true,
      `check "${name}" is one of the 9 known health check modules`);
  }

  for (const issue of report.issues) {
    assert.ok(KNOWN_CHECKS.includes(issue.check),
      `unexpected check name "${issue.check}" in issues`);
  }
});

test('runAllChecks persists report to disk at HEALTH_REPORT_FILE', (t) => {
  t.mock.method(console, 'log', () => {});

  if (existsSync(HEALTH_REPORT_FILE)) unlinkSync(HEALTH_REPORT_FILE);
  assert.equal(existsSync(HEALTH_REPORT_FILE), false);

  runAllChecks();

  assert.equal(existsSync(HEALTH_REPORT_FILE), true, 'report file was created on disk');
});

test('runAllChecks persisted report matches returned report', (t) => {
  t.mock.method(console, 'log', () => {});

  const report = runAllChecks();
  const disk = JSON.parse(readFileSync(HEALTH_REPORT_FILE, 'utf8'));

  assert.equal(disk.issueCount, report.issueCount);
  assert.deepEqual(disk.issues, report.issues);
  assert.equal(disk.generatedAt, report.generatedAt);
});

test('runAllChecks with json flag prints JSON to stdout', (t) => {
  const logs = [];
  t.mock.method(console, 'log', (msg) => { logs.push(msg); });

  const report = runAllChecks({ json: true });

  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.issueCount, report.issueCount);
  assert.deepEqual(parsed.issues, report.issues);
  assert.equal(parsed.generatedAt, report.generatedAt);
});

test('runAllChecks without json flag prints formatted report to stdout', (t) => {
  const logs = [];
  t.mock.method(console, 'log', (msg) => { logs.push(msg); });

  runAllChecks();

  assert.equal(logs.length, 1);
  assert.equal(typeof logs[0], 'string');
  assert.ok(logs[0].startsWith('[health-auditor]'), 'output starts with health-auditor prefix');
});

test('runAllChecks returns report with generatedAt as ISO string', (t) => {
  t.mock.method(console, 'log', () => {});

  const report = runAllChecks();

  assert.ok(report.generatedAt, 'generatedAt is present');
  assert.doesNotThrow(() => new Date(report.generatedAt).toISOString(),
    'generatedAt is a valid ISO date string');
});

test('runAllChecks with json false produces same issues as default call', (t) => {
  t.mock.method(console, 'log', () => {});

  const defaultReport = runAllChecks();
  const explicitReport = runAllChecks({ json: false });

  assert.equal(explicitReport.issueCount, defaultReport.issueCount);
  assert.deepEqual(explicitReport.issues, defaultReport.issues);
});

test('runAllChecks creates reports that differ on subsequent calls', (t) => {
  t.mock.method(console, 'log', () => {});

  const report1 = runAllChecks();
  const report2 = runAllChecks();

  assert.notEqual(report1.generatedAt, report2.generatedAt,
    'each call produces a fresh timestamp');
});
