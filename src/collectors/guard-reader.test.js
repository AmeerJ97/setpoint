import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Sandbox: redirect claude-ops paths into a temp directory so we control
// what guard.log, guard-config, etc. contain without touching the real ones.
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), 'guard-reader-test-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');

const PLUGIN_DIR = join(SANDBOX, '.claude', 'plugins', 'claude-ops');
const GUARD_LOG_FILE = join(PLUGIN_DIR, 'guard.log');
const GUARD_CONFIG_DIR = join(PLUGIN_DIR, 'guard-config');

// Date helpers — used for constructing deterministic timestamps
const pad2 = (n) => String(n).padStart(2, '0');
const now = new Date();
const todayLocal = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

// ---------------------------------------------------------------------------
// PATH-based mocking for systemctl / pgrep  (works on any Node.js version)
// We inject a bin/ directory at the front of PATH containing stub scripts
// that respond to the requested service state. pgrep is intentionally kept
// available so tests can prove a process-name match alone is not authoritative.
// ---------------------------------------------------------------------------
const MOCK_BIN = join(SANDBOX, 'bin');
const SYSTEMCTL_STUB = join(MOCK_BIN, 'systemctl');
const PGREP_STUB = join(MOCK_BIN, 'pgrep');

/**
 * Write the mock shell-stub scripts and prepend MOCK_BIN to PATH.
 * @param {'running'|'fallback'|'inactive'} mode
 */
function setGuardMockMode(mode) {
  mkdirSync(MOCK_BIN, { recursive: true });

  let systemctlCode, pgrepCode;

  if (mode === 'running') {
    systemctlCode = `#!/usr/bin/env bash
if [[ "$*" == *"is-active"* ]]; then echo "active"; exit 0; fi
if [[ "$*" == *"is-enabled"* ]]; then echo "enabled"; exit 0; fi
exit 1
`;
    pgrepCode = `#!/usr/bin/env bash\necho "99999"\nexit 0`;
  } else if (mode === 'fallback') {
    systemctlCode = `#!/usr/bin/env bash
if [[ "$*" == *"is-active"* ]]; then echo "inactive"; exit 3; fi
if [[ "$*" == *"is-enabled"* ]]; then echo "disabled"; exit 1; fi
exit 1
`;
    pgrepCode = `#!/usr/bin/env bash\necho "99999"\nexit 0`;
  } else {
    systemctlCode = `#!/usr/bin/env bash
if [[ "$*" == *"is-active"* ]]; then echo "inactive"; exit 3; fi
if [[ "$*" == *"is-enabled"* ]]; then echo "disabled"; exit 1; fi
exit 1
`;
    pgrepCode = `#!/usr/bin/env bash\nexit 1`;
  }

  writeFileSync(SYSTEMCTL_STUB, systemctlCode, { mode: 0o755 });
  writeFileSync(PGREP_STUB, pgrepCode, { mode: 0o755 });

  const pathParts = process.env.PATH ? process.env.PATH.split(':') : [];
  if (pathParts[0] !== MOCK_BIN) {
    process.env.PATH = [MOCK_BIN, ...pathParts].join(':');
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function writeLog(lines) {
  mkdirSync(PLUGIN_DIR, { recursive: true });
  writeFileSync(GUARD_LOG_FILE, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}

function removeLog() {
  try { rmSync(GUARD_LOG_FILE); } catch { /* may not exist */ }
}

function writeSkip(category, reason) {
  mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
  writeFileSync(join(GUARD_CONFIG_DIR, `${category}.skip`), '');
  if (reason !== undefined) {
    writeFileSync(join(GUARD_CONFIG_DIR, `${category}.skip.reason`), reason + '\n');
  }
}

function clearGuardConfig() {
  rmSync(GUARD_CONFIG_DIR, { recursive: true, force: true });
  mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
}

let guardReader;

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------
before(async () => {
  // Ensure sandbox directory structure exists
  mkdirSync(GUARD_CONFIG_DIR, { recursive: true });

  // Set up PATH-based stubs for systemctl / pgrep
  setGuardMockMode('inactive');

  // Import the module under test (dynamic import is fine inside before)
  guardReader = await import('./guard-reader.js');
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

// ===========================================================================
// Tests
// ===========================================================================

describe('parseGuardLog', () => {

  it('parses ISO-format timestamps and extracts flags', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'swann_brevity');
    assert.equal(s.lastFlagCount, 1);
    assert.ok(s.lastActivation instanceof Date);
    assert.equal(s.lastActivation.getTime(), new Date(`${todayLocal}T12:00:00.000Z`).getTime());
  });

  it('parses legacy [HH:MM:SS] timestamps', async () => {
    removeLog();
    writeLog([
      '[08:30:00] Re-applied: tengu_sotto_voce (1 overrides)',
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'sotto_voce');
    assert.equal(s.lastFlagCount, 1);
    assert.ok(s.lastActivation instanceof Date);
    const expected = new Date(`${todayLocal}T08:30:00`).getTime();
    assert.equal(s.lastActivation.getTime(), expected);
  });

  it('parses multiple flags in one line', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_swann_brevity, tengu_sotto_voce, tengu_amber_wren (3 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'swann_brevity');
    assert.equal(s.lastFlagCount, 3);
    assert.deepEqual(s.flagCounts, { swann_brevity: 1, sotto_voce: 1, amber_wren: 1 });
  });

  it('ignores lines without "Re-applied" marker', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T10:00:00.000Z Guard started`,
      `${todayLocal}T10:00:01.000Z Config loaded`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'swann_brevity');
    assert.equal(s.activationsToday, 1);
  });

  it('skips lines with unparseable timestamps', async () => {
    removeLog();
    writeLog([
      `garbage Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_sotto_voce (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'sotto_voce');
    assert.equal(s.lastFlagCount, 1);
  });

  it('returns empty result for missing log file', async () => {
    removeLog();
    const s = await guardReader.readGuardStatus();
    assert.equal(s.activationsToday, 0);
    assert.equal(s.activationsLastHour, 0);
    assert.equal(s.lastActivation, null);
    assert.equal(s.lastFlag, null);
    assert.equal(s.lastFlagCount, 0);
    assert.deepEqual(s.flagCounts, {});
    assert.equal(s.topFlag, null);
  });

  it('returns empty result for empty log file', async () => {
    removeLog();
    writeLog([]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.activationsToday, 0);
    assert.equal(s.lastFlag, null);
    assert.equal(s.topFlag, null);
  });

  it('handles lines with 0 overrides (no flags parsed)', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied:  (0 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, null);
    assert.equal(s.lastFlagCount, 0);
    assert.equal(s.activationsToday, 1);
  });

  it('sets lastActivation to the most recent entry', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T10:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_sotto_voce (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation.getTime(), new Date(`${todayLocal}T12:00:00.000Z`).getTime());
    assert.equal(s.lastFlag, 'sotto_voce');
  });

  it('aggregates flag counts per day', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T10:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T11:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_sotto_voce (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.deepEqual(s.flagCounts, { swann_brevity: 2, sotto_voce: 1 });
    assert.equal(s.topFlag, 'swann_brevity');
  });

  it('counts activations in the last hour', async () => {
    removeLog();
    const withinHour = new Date(Date.now() - 10 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const outsideHour = new Date(Date.now() - 90 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    writeLog([
      `${withinHour} Re-applied: tengu_swann_brevity (1 overrides)`,
      `${outsideHour} Re-applied: tengu_sotto_voce (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.activationsLastHour, 1);
  });

  it('handles bulk re-apply with 15+ flags (sets lastFlagCount, still sets lastFlag)', async () => {
    removeLog();
    const flags = Array.from({ length: 18 }, (_, i) => `tengu_flag_${i}`);
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: ${flags.join(', ')} (18 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlagCount, 18);
    assert.equal(s.lastFlag, 'flag_0');
    assert.equal(Object.keys(s.flagCounts).length, 18);
  });

  it('strips tengu_ prefix in flag counts and lastFlag', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T10:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T11:00:00.000Z Re-applied: tengu_amber_wren (1 overrides)`,
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_amber_wren (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.ok('swann_brevity' in s.flagCounts);
    assert.ok('amber_wren' in s.flagCounts);
    assert.ok(!('tengu_swann_brevity' in s.flagCounts));
    assert.equal(s.topFlag, 'amber_wren');
  });
});

// ---------------------------------------------------------------------------
// listSkippedCategories — exercised through readGuardStatus
// ---------------------------------------------------------------------------
describe('listSkippedCategories', () => {

  it('returns categories from .skip files', async () => {
    clearGuardConfig();
    writeSkip('brevity');
    writeSkip('sotto_voce');
    const s = await guardReader.readGuardStatus();
    assert.ok(s.skippedCategories.includes('brevity'));
    assert.ok(s.skippedCategories.includes('sotto_voce'));
    assert.equal(s.skippedCount, 2);
  });

  it('returns empty array when no .skip files exist', async () => {
    clearGuardConfig();
    const s = await guardReader.readGuardStatus();
    assert.deepEqual(s.skippedCategories, []);
    assert.equal(s.skippedCount, 0);
  });

  it('returns empty array when guard-config directory is missing', async () => {
    rmSync(GUARD_CONFIG_DIR, { recursive: true, force: true });
    const s = await guardReader.readGuardStatus();
    assert.deepEqual(s.skippedCategories, []);
    assert.equal(s.skippedCount, 0);
    mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// readSkipReasons — exercised through readGuardStatus
// ---------------------------------------------------------------------------
describe('readSkipReasons', () => {

  it('reads single-line reasons from .skip.reason files', async () => {
    clearGuardConfig();
    writeSkip('brevity', 'opus_4_7_incompatible');
    writeSkip('sotto_voce', 'manual_triage');
    const s = await guardReader.readGuardStatus();
    assert.equal(s.skipReasons.brevity, 'opus_4_7_incompatible');
    assert.equal(s.skipReasons.sotto_voce, 'manual_triage');
  });

  it('ignores categories that exist but have no .skip.reason file', async () => {
    clearGuardConfig();
    writeSkip('brevity');
    writeSkip('sotto_voce', 'manual_triage');
    const s = await guardReader.readGuardStatus();
    assert.ok(!('brevity' in s.skipReasons));
    assert.equal(s.skipReasons.sotto_voce, 'manual_triage');
  });

  it('skips empty reason files', async () => {
    clearGuardConfig();
    writeSkip('brevity', '');
    const s = await guardReader.readGuardStatus();
    assert.ok(!('brevity' in s.skipReasons));
  });
});

// ---------------------------------------------------------------------------
// isGuardRunning — PATH-based mock scripts control service state
// ---------------------------------------------------------------------------
describe('isGuardRunning', () => {

  it('returns true when systemctl reports active', async () => {
    setGuardMockMode('running');
    removeLog();
    writeLog([]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.running, true);
  });

  it('does not treat a pgrep-only match as an authoritative running guard', async () => {
    setGuardMockMode('fallback');
    removeLog();
    writeLog([]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.running, false);
    assert.equal(s.activeState, 'inactive');
    assert.equal(s.enabledState, 'disabled');
  });

  it('returns false when neither systemctl nor pgrep find the guard', async () => {
    setGuardMockMode('inactive');
    removeLog();
    writeLog([]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.running, false);
  });
});

// ---------------------------------------------------------------------------
// parseActivationTimestamp — tested through log line parsing
// ---------------------------------------------------------------------------
describe('parseActivationTimestamp', () => {

  it('parses ISO format with Z suffix', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:34:56Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation.getTime(), new Date(`${todayLocal}T12:34:56Z`).getTime());
  });

  it('parses ISO format with timezone offset', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:34:56-07:00 Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation.getTime(), new Date(`${todayLocal}T12:34:56-07:00`).getTime());
  });

  it('parses ISO format with fractional seconds', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:34:56.789Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation.getTime(), new Date(`${todayLocal}T12:34:56.789Z`).getTime());
  });

  it('rejects bad timestamp format (line skipped)', async () => {
    removeLog();
    writeLog([
      `not-a-timestamp Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation, null);
    assert.equal(s.activationsToday, 0);
  });

  it('rejects malformed lines that partially resemble ISO', async () => {
    removeLog();
    writeLog([
      `2026-13-99T99:99:99Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastActivation, null);
    assert.equal(s.activationsToday, 0);
  });
});

// ---------------------------------------------------------------------------
// parseFlagsFromLine — tested through log line parsing
// ---------------------------------------------------------------------------
describe('parseFlagsFromLine', () => {

  it('extracts a single flag', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'swann_brevity');
    assert.equal(s.lastFlagCount, 1);
  });

  it('extracts multiple flags stripped of tengu_ prefix', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_flag_a, tengu_flag_b, tengu_flag_c (3 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'flag_a');
    assert.equal(s.lastFlagCount, 3);
    assert.deepEqual(Object.keys(s.flagCounts).sort(), ['flag_a', 'flag_b', 'flag_c']);
  });

  it('returns zero flags when the flag section is empty', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Re-applied:  (0 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, null);
    assert.equal(s.lastFlagCount, 0);
  });

  it('returns zero flags when line does not match the Re-applied pattern', async () => {
    removeLog();
    writeLog([
      `${todayLocal}T12:00:00.000Z Reapplied tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, null);
    assert.equal(s.lastFlagCount, 0);
  });
});

// ---------------------------------------------------------------------------
// Combined readGuardStatus — end-to-end smoke test
// ---------------------------------------------------------------------------
describe('readGuardStatus (combined)', () => {

  it('returns all fields with expected shapes and values', async () => {
    setGuardMockMode('running');
    clearGuardConfig();
    writeSkip('brevity', 'testing');
    writeSkip('sotto_voce');
    removeLog();
    writeLog([
      `${todayLocal}T10:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      `${todayLocal}T11:00:00.000Z Re-applied: tengu_amber_wren (1 overrides)`,
      `${todayLocal}T12:00:00.000Z Re-applied: tengu_amber_wren (1 overrides)`,
    ]);

    const s = await guardReader.readGuardStatus();

    // Type/shape assertions
    assert.equal(typeof s.running, 'boolean');
    assert.equal(typeof s.activationsToday, 'number');
    assert.equal(typeof s.activationsLastHour, 'number');
    assert.ok(s.lastActivation instanceof Date || s.lastActivation === null);
    assert.equal(typeof s.lastFlagCount, 'number');
    assert.equal(typeof s.flagCounts, 'object');
    assert.equal(typeof s.skippedCount, 'number');
    assert.ok(Array.isArray(s.skippedCategories));
    assert.equal(typeof s.skipReasons, 'object');

    // Value assertions
    assert.equal(s.running, true);
    assert.equal(s.skippedCount, 2);
    assert.ok(s.skippedCategories.includes('brevity'));
    assert.ok(s.skippedCategories.includes('sotto_voce'));
    assert.equal(s.skipReasons.brevity, 'testing');
    assert.equal(s.lastFlag, 'amber_wren');
    assert.equal(s.topFlag, 'amber_wren');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('edge cases', () => {

  it('tolerates missing guard-config directory and missing log simultaneously', async () => {
    setGuardMockMode('inactive');
    rmSync(GUARD_CONFIG_DIR, { recursive: true, force: true });
    removeLog();
    const s = await guardReader.readGuardStatus();
    assert.equal(s.running, false);
    assert.equal(s.activationsToday, 0);
    assert.equal(s.skippedCount, 0);
    assert.deepEqual(s.skipReasons, {});
    assert.equal(s.lastFlag, null);
    mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
  });

  it('handles log lines with leading whitespace', async () => {
    removeLog();
    writeLog([
      `  ${todayLocal}T12:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
    ]);
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'swann_brevity');
    assert.equal(s.lastFlagCount, 1);
  });

  it('handles multiple consecutive empty lines in log', async () => {
    removeLog();
    writeFileSync(GUARD_LOG_FILE, [
      `${todayLocal}T10:00:00.000Z Re-applied: tengu_swann_brevity (1 overrides)`,
      '',
      '',
      `${todayLocal}T11:00:00.000Z Re-applied: tengu_sotto_voce (1 overrides)`,
      '',
    ].join('\n'));
    const s = await guardReader.readGuardStatus();
    assert.equal(s.lastFlag, 'sotto_voce');
    assert.equal(s.activationsToday, 2);
  });

  it('takes only the first line of .skip.reason file', async () => {
    clearGuardConfig();
    mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
    writeFileSync(join(GUARD_CONFIG_DIR, 'brevity.skip'), '');
    writeFileSync(join(GUARD_CONFIG_DIR, 'brevity.skip.reason'), 'opus_4_7_incompatible\nsecond line\nthird line\n');
    const s = await guardReader.readGuardStatus();
    assert.equal(s.skipReasons.brevity, 'opus_4_7_incompatible');
  });

  it('handles .skip file without corresponding .skip.reason', async () => {
    clearGuardConfig();
    mkdirSync(GUARD_CONFIG_DIR, { recursive: true });
    writeFileSync(join(GUARD_CONFIG_DIR, 'brevity.skip'), '');
    const s = await guardReader.readGuardStatus();
    assert.ok(s.skippedCategories.includes('brevity'));
    assert.ok(!('brevity' in s.skipReasons));
  });
});
