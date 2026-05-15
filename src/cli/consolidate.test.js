import { test, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BASELINE_DIR = mkdtempSync(join(tmpdir(), 'consolidate-base-'));
let main;

function setupBaseline() {
  process.env.CLAUDE_CONFIG_DIR = join(BASELINE_DIR, '.claude');
  const claudeDir = process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(claudeDir, 'skills'), { recursive: true });
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
}

function writeProposals(baseDir, proposals = []) {
  const d = join(baseDir, '.claude', 'plugins', 'claude-ops', 'consolidate');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'proposals.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    sources: { skills: 0, commands: 0, agents: 0, memory: 0 },
    proposals,
  }));
}

function writeGateState(baseDir, overrides = {}) {
  const d = join(baseDir, '.claude', 'plugins', 'claude-ops', 'consolidate');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'gate-state.json'), JSON.stringify({
    snapshot: null,
    probes: {
      qmd: { ok: false, at: Date.now() + 3_600_000 },
      claude: { ok: false, at: Date.now() + 3_600_000 },
    },
    lastScanAt: 0,
    ...overrides,
  }));
}

function captureStd() {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, _, cb) => {
    out.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c));
    if (typeof cb === 'function') cb();
    return true;
  };
  process.stderr.write = (c, _, cb) => {
    err.push(Buffer.isBuffer(c) ? c.toString('utf8') : String(c));
    if (typeof cb === 'function') cb();
    return true;
  };
  return {
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; },
  };
}

function resetBaseline() {
  const claudeDir = join(BASELINE_DIR, '.claude');
  for (const sub of ['gate-state.json', 'proposals.json']) {
    try { rmSync(join(claudeDir, 'plugins', 'claude-ops', 'consolidate', sub)); } catch {}
  }
  for (const sub of ['skills', 'commands', 'agents']) {
    const dir = join(claudeDir, sub);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    mkdirSync(dir, { recursive: true });
  }
  try {
    rmSync(join(claudeDir, 'plugins'), { recursive: true, force: true });
  } catch {}
}

before(async () => {
  setupBaseline();
  const mod = await import('./consolidate.js');
  main = mod.main;
});

afterEach(() => {
  process.env.CLAUDE_CONFIG_DIR = join(BASELINE_DIR, '.claude');
  resetBaseline();
});

// ─── printUsage — help subcommand ─────────────────────────

test('main() with no args prints usage and returns 0', async () => {
  const cap = captureStd();
  const code = await main([]);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /claude-ops consolidate/);
  assert.match(cap.stdout(), /Usage/);
  assert.match(cap.stdout(), /scan/);
  assert.match(cap.stdout(), /status/);
  assert.match(cap.stdout(), /apply/);
  assert.match(cap.stdout(), /undo/);
  assert.match(cap.stdout(), /Safety/);
});

test('main(["help"]) prints usage and returns 0', async () => {
  const cap = captureStd();
  const code = await main(['help']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /claude-ops consolidate/);
});

test('main(["--help"]) prints usage and returns 0', async () => {
  const cap = captureStd();
  const code = await main(['--help']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /Usage/);
});

test('main(["-h"]) prints usage and returns 0', async () => {
  const cap = captureStd();
  const code = await main(['-h']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /Usage/);
});

test('main(["unknown-sub"]) prints error + usage and returns 2', async () => {
  const cap = captureStd();
  const code = await main(['does-not-exist']);
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.stderr(), /unknown subcommand/);
  assert.match(cap.stdout(), /Usage/);
});

// ─── status subcommand ────────────────────────────────────

test('status with no proposals file prints empty report', async () => {
  const cap = captureStd();
  const code = await main(['status']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /consolidate status/);
  assert.match(cap.stdout(), /Proposals/);
});

test('status --json with no proposals file produces valid JSON', async () => {
  const cap = captureStd();
  const code = await main(['status', '--json']);
  cap.restore();
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.stdout());
  assert.deepEqual(parsed.counts, { pending: 0, applied: 0, dismissed: 0 });
  assert.equal(parsed.proposals.length, 0);
});

test('status shows pending / applied / dismissed counts', async () => {
  writeProposals(BASELINE_DIR, [
    { id: 'prop-0001', kind: 'merge_overlap', status: 'pending', confidence: 0.85,
      reason: 'overlapping skills foo and bar', sources: ['/tmp/foo.md'], target: '/tmp/bar.md',
      diffPreview: 'merge 2 artifacts →', haikuOutput: null, autoApplyable: false,
      identity: 'a1', createdAt: Date.now() },
    { id: 'prop-0002', kind: 'merge_overlap', status: 'applied', confidence: 0.7,
      reason: 'already done', sources: [], target: '',
      diffPreview: '', haikuOutput: null, autoApplyable: false,
      identity: 'a2', createdAt: Date.now() },
    { id: 'prop-0003', kind: 'promote_memory', status: 'dismissed', confidence: 0.6,
      reason: 'dismissed by user', sources: [], target: '',
      diffPreview: '', haikuOutput: null, autoApplyable: false,
      identity: 'a3', createdAt: Date.now() },
  ]);
  const cap = captureStd();
  const code = await main(['status']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /1 pending · 1 applied · 1 dismissed/);
  assert.match(cap.stdout(), /overlapping skills foo and bar/);
});

test('status --json returns structured proposal data', async () => {
  writeProposals(BASELINE_DIR, [
    { id: 'prop-0042', kind: 'merge_overlap', status: 'pending', confidence: 0.9,
      reason: 'high confidence overlap', sources: [], target: '',
      diffPreview: '', haikuOutput: null, autoApplyable: false,
      identity: 'x1', createdAt: Date.now() },
  ]);
  const cap = captureStd();
  const code = await main(['status', '--json']);
  cap.restore();
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.stdout());
  assert.equal(parsed.counts.pending, 1);
  assert.ok(parsed.generatedAt);
  assert.equal(parsed.proposals[0].id, 'prop-0042');
  assert.equal(parsed.proposals[0].kind, 'merge_overlap');
  assert.equal(parsed.proposals[0].status, 'pending');
  assert.equal(parsed.proposals[0].confidence, 0.9);
});

// ─── scan subcommand ──────────────────────────────────────

test('scan with no artifacts prints empty message', async () => {
  writeGateState(BASELINE_DIR);
  const cap = captureStd();
  const code = await main(['scan']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /no artifacts found/);
});

test('scan --json with no artifacts produces valid JSON', async () => {
  writeGateState(BASELINE_DIR);
  const cap = captureStd();
  const code = await main(['scan', '--json']);
  cap.restore();
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.stdout());
  assert.equal(parsed.proposals, 0);
  assert.ok(parsed.sources);
});

test('scan discovers artifacts in baseline dir', async () => {
  const skillDir = join(BASELINE_DIR, '.claude', 'skills', 'alpha-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Alpha Skill\n\nThis skill manages file archiving and retrieval for user workflows.');
  writeFileSync(join(BASELINE_DIR, '.claude', 'commands', 'beta-cmd.md'),
    '# Beta Command\n\nA command that archives old files and retrieves them when needed.');
  writeFileSync(join(BASELINE_DIR, '.claude', 'agents', 'gamma-agent.md'),
    '# Gamma Agent\n\nAn agent for managing file archives and retrieval tasks.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /"skill":1/);
  assert.match(cap.stdout(), /"command":1/);
  assert.match(cap.stdout(), /"agent":1/);
  assert.match(cap.stdout(), /Sources/);
  assert.match(cap.stdout(), /Clusters/);
  assert.match(cap.stdout(), /Scorer/);
  assert.match(cap.stdout(), /scan: discovering artifacts/);
  assert.match(cap.stdout(), /scan: writing/);
});

test('scan --json with artifacts returns structured scan result', async () => {
  const skillDir = join(BASELINE_DIR, '.claude', 'skills', 'test-me');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Test Me\n\nSkill content for JSON output verification test.');
  writeFileSync(join(BASELINE_DIR, '.claude', 'commands', 'check.md'),
    '# Check\n\nCommand content for JSON output verification test.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--json']);
  cap.restore();
  assert.equal(code, 0);
  const parsed = JSON.parse(cap.stdout());
  assert.equal(parsed.ok, true);
  assert.ok(parsed.sources.skill >= 1);
  assert.ok(parsed.sources.command >= 1);
  assert.ok(typeof parsed.novelty === 'number');
  assert.ok(typeof parsed.clusters === 'number');
  assert.equal(parsed.scorer, 'bm25');
  assert.ok(parsed.file);
  assert.equal(parsed.haiku, false);
  assert.equal(parsed.qmd, false);
});

test('scan respects --include flag to restrict source kinds', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'only-skill'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'only-skill', 'SKILL.md'), '# Only Skill\n\nContent');
  writeFileSync(join(BASELINE_DIR, '.claude', 'commands', 'should-not-appear.md'),
    '# Should Not Appear\n\nCommand content.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--include', 'skills']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /"skill":1/);
  assert.doesNotMatch(cap.stdout(), /"command":1/);
});

test('scan respects --exclude flag to filter paths', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'keep'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'keep', 'SKILL.md'), '# Keep\n\nKeep this skill.');
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'drop'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'drop', 'SKILL.md'), '# Drop\n\nDrop this skill.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--exclude', 'drop']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /"skill":1/);
});

test('scan --no-haiku disables haiku enrichment', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'h-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'h-test', 'SKILL.md'), '# H Test\n\nContent for haiku flag test.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--no-haiku']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /haiku:\s+disabled/);
});

// ─── scan — sim, novelty, force flags ─────────────────────

test('scan --sim accepts custom similarity threshold', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'sim-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'sim-test', 'SKILL.md'), '# Sim Test\n\nContent.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--sim', '0.9']);
  cap.restore();
  assert.equal(code, 0);
});

test('scan --novelty accepts custom novelty threshold', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'novelty-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'novelty-test', 'SKILL.md'), '# Novelty Test\n\nContent.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--novelty', '0.5']);
  cap.restore();
  assert.equal(code, 0);
});

test('scan --force bypasses novelty gate skip', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'force-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'force-test', 'SKILL.md'), '# Force Test\n\nContent.');
  writeGateState(BASELINE_DIR, { snapshot: { count: 3, hash: 'old', files: {} } });

  // First scan — should skip due to stale snapshot + no changes
  const cap1 = captureStd();
  const code1 = await main(['scan']);
  cap1.restore();
  assert.equal(code1, 0);

  // Second scan with --force should run regardless
  const cap2 = captureStd();
  const code2 = await main(['scan', '--force']);
  cap2.restore();
  assert.equal(code2, 0);
  assert.match(cap2.stdout(), /Sources/);
});

// ─── apply subcommand ─────────────────────────────────────

test('apply without --experimental prints experimental gate message and returns 2', async () => {
  const cap = captureStd();
  const code = await main(['apply']);
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.stderr(), /experimental/);
});

test('apply --id without --experimental prints gate message and returns 2', async () => {
  const cap = captureStd();
  const code = await main(['apply', '--id', 'prop-0001']);
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.stderr(), /experimental/);
});

test('apply --all without --confirm prints error and returns 2', async () => {
  const cap = captureStd();
  const code = await main(['apply', '--all', '--experimental']);
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.stderr(), /requires --confirm/);
});

test('apply --id with --experimental attempts apply against store', async () => {
  const skillPath = join(BASELINE_DIR, '.claude', 'skills', 'source-skill', 'SKILL.md');
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'source-skill'), { recursive: true });
  writeFileSync(skillPath, '# Source\n\nContent.');
  writeProposals(BASELINE_DIR, [{
    id: 'prop-0001', kind: 'merge_overlap', status: 'pending', confidence: 0.8,
    sources: [skillPath],
    target: join(BASELINE_DIR, '.claude', 'skills', 'target-skill', 'SKILL.md'),
    diffPreview: 'merge 2 artifacts →', haikuOutput: { body: 'Merged body content.' },
    autoApplyable: false, reason: 'overlap test', identity: 'abc', createdAt: Date.now(),
  }]);

  const cap = captureStd();
  const code = await main(['apply', '--id', 'prop-0001', '--experimental']);
  cap.restore();
  assert.equal(code, 0);
  assert.match(cap.stdout(), /applied/);
});

test('apply --id --yes --experimental passes yes flag', async () => {
  writeProposals(BASELINE_DIR, [{
    id: 'prop-0002', kind: 'merge_overlap', status: 'pending', confidence: 0.75,
    sources: ['/tmp/nonexistent-source.md'],
    target: join(BASELINE_DIR, '.claude', 'skills', 'nonexistent', 'SKILL.md'),
    diffPreview: '', haikuOutput: { body: 'body' },
    autoApplyable: false, reason: 'yes flag test', identity: 'xyz', createdAt: Date.now(),
  }]);

  const cap = captureStd();
  const code = await main(['apply', '--id', 'prop-0002', '--yes', '--experimental']);
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.stdout(), /FAILED/);
});

test('apply --all --confirm --experimental attempts all pending', async () => {
  writeProposals(BASELINE_DIR, [
    {
      id: 'prop-0010', kind: 'merge_overlap', status: 'pending', confidence: 0.8,
      sources: ['/tmp/source.md'],
      target: join(BASELINE_DIR, '.claude', 'skills', 'all-test', 'SKILL.md'),
      diffPreview: '', haikuOutput: { body: 'body' },
      autoApplyable: false, reason: 'all test 1', identity: 'all1', createdAt: Date.now(),
    },
  ]);

  const cap = captureStd();
  const code = await main(['apply', '--all', '--confirm', '--experimental']);
  cap.restore();
  assert.match(cap.stdout(), /applied \d+/);
});

// ─── undo subcommand ─────────────────────────────────────

test('undo --last with no backups returns error', async () => {
  const cap = captureStd();
  const code = await main(['undo', '--last']);
  cap.restore();
  assert.match(cap.stdout(), /FAILED/);
});

test('undo without --last or --ts still runs (defaults to --last)', async () => {
  const cap = captureStd();
  const code = await main(['undo']);
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.stdout(), /FAILED/);
});

// ─── parseArgs — flag combinations via status --json ──────

test('parseArgs: --yes short form -y', async () => {
  // Test -y by calling apply with a proposal (same as --yes)
  writeProposals(BASELINE_DIR, [{
    id: 'prop-0099', kind: 'merge_overlap', status: 'pending', confidence: 0.5,
    sources: ['/tmp/missing.md'],
    target: join(BASELINE_DIR, '.claude', 'skills', 'y-test', 'SKILL.md'),
    diffPreview: '', haikuOutput: { body: 'content' },
    autoApplyable: false, reason: 'y flag', identity: 'y99', createdAt: Date.now(),
  }]);

  const cap = captureStd();
  const code = await main(['apply', '--id', 'prop-0099', '-y', '--experimental']);
  cap.restore();
  assert.equal(code, 1);
  assert.match(cap.stdout(), /FAILED/);
});

test('parseArgs: --haiku-budget limits haiku calls', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'budget-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'budget-test', 'SKILL.md'), '# Budget\n\nContent for budget test.');
  writeGateState(BASELINE_DIR);

  const cap = captureStd();
  const code = await main(['scan', '--haiku-budget', '5']);
  cap.restore();
  assert.equal(code, 0);
});

// ─── scan — --qmd refused without consent env ─────────────

test('scan --qmd is refused without CLAUDE_OPS_QMD_DANGEROUS_ENABLE', async () => {
  mkdirSync(join(BASELINE_DIR, '.claude', 'skills', 'qmd-test'), { recursive: true });
  writeFileSync(join(BASELINE_DIR, '.claude', 'skills', 'qmd-test', 'SKILL.md'), '# QMD Test\n\nContent to prevent early return.');
  writeGateState(BASELINE_DIR);
  const cap = captureStd();
  const code = await main(['scan', '--qmd']);
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.stderr(), /--qmd refused/);
});

// ─── scan — store and gate state files created ────────────

test('scan writes proposals.json and gate-state.json', async () => {
  const skillDir = join(BASELINE_DIR, '.claude', 'skills', 'write-test');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '# Write Test\n\nContent to trigger file writes.');
  writeGateState(BASELINE_DIR);

  const consolidateDir = join(BASELINE_DIR, '.claude', 'plugins', 'claude-ops', 'consolidate');

  const cap = captureStd();
  const code = await main(['scan']);
  cap.restore();
  assert.equal(code, 0);
  assert.equal(existsSync(join(consolidateDir, 'proposals.json')), true);
  assert.equal(existsSync(join(consolidateDir, 'gate-state.json')), true);

  const store = JSON.parse(readFileSync(join(consolidateDir, 'proposals.json'), 'utf8'));
  assert.ok(Array.isArray(store.proposals));
  assert.ok(store.generatedAt);
});
