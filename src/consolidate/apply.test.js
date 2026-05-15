import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractAssistantText, extractJson } from './haiku.js';

function tmp(prefix) { return mkdtempSync(join(tmpdir(), `engram-lite-${prefix}-`)); }

// ---- Haiku parser: extractAssistantText shape tolerance ------------------

test('extractAssistantText: flat string envelope', () => {
  const out = extractAssistantText(JSON.stringify({ result: 'hello world' }));
  assert.equal(out, 'hello world');
});

test('extractAssistantText: content-block array (Claude native)', () => {
  const out = extractAssistantText(JSON.stringify({
    content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }],
  }));
  assert.ok(out.includes('part one'));
  assert.ok(out.includes('part two'));
});

test('extractAssistantText: nested envelope', () => {
  const out = extractAssistantText(JSON.stringify({ message: { content: 'nested payload' } }));
  assert.equal(out, 'nested payload');
});

test('extractAssistantText: non-JSON falls back to raw', () => {
  const out = extractAssistantText('plain assistant text without json');
  assert.equal(out, 'plain assistant text without json');
});

test('extractAssistantText: empty input returns null', () => {
  assert.equal(extractAssistantText(''), null);
  assert.equal(extractAssistantText(null), null);
});

// ---- Haiku parser: extractJson tolerance ---------------------------------

test('extractJson: fenced ```json block', () => {
  const p = extractJson('Sure thing!\n```json\n{"x": 1, "y": "two"}\n```\nDone.');
  assert.deepEqual(p, { x: 1, y: 'two' });
});

test('extractJson: unfenced balanced object', () => {
  const p = extractJson('Here you go: {"promote_to": "skill", "proposed_name": "foo"}');
  assert.equal(p.promote_to, 'skill');
  assert.equal(p.proposed_name, 'foo');
});

test('extractJson: any code fence, not just json', () => {
  const p = extractJson('```\n{"a": [1, 2, 3]}\n```');
  assert.deepEqual(p.a, [1, 2, 3]);
});

test('extractJson: escaped quotes inside strings', () => {
  const p = extractJson('noise {"msg": "he said \\"hi\\"", "n": 2} trailing');
  assert.equal(p.msg, 'he said "hi"');
  assert.equal(p.n, 2);
});

test('extractJson: unparseable returns null', () => {
  assert.equal(extractJson('just prose, no json'), null);
  assert.equal(extractJson(''), null);
});

// ---- apply/undo round-trip -----------------------------------------------

test('apply merge_overlap + undo round-trip', async (t) => {
  const fakeHome = tmp('home');
  const stateDir = tmp('state');
  const priorHome = process.env.HOME;
  const priorClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    if (priorHome == null) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorClaudeConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorClaudeConfigDir;
  });
  // Scaffold a fake ~/.claude/ inside fakeHome so DEFAULT_ROOTS points there.
  process.env.CONSOLIDATE_DIR = stateDir;
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_CONFIG_DIR;
  mkdirSync(join(fakeHome, '.claude', 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(fakeHome, '.claude', 'skills', 'beta'),  { recursive: true });
  const alphaPath = join(fakeHome, '.claude', 'skills', 'alpha', 'SKILL.md');
  const betaPath  = join(fakeHome, '.claude', 'skills', 'beta',  'SKILL.md');
  writeFileSync(alphaPath, 'original alpha body');
  writeFileSync(betaPath,  'original beta body');

  // Fresh imports after env setup so DEFAULT_ROOTS picks up HOME.
  const { loadStore, saveStore, reconcile } = await import(`./propose.js?cb=${Date.now()}`);
  const { applyProposal, undo } = await import(`./apply.js?cb=${Date.now()}`);

  const store = reconcile([{
    kind: 'merge_overlap',
    confidence: 0.9,
    sources: [alphaPath, betaPath],
    target: alphaPath,
    diffPreview: 'merge',
    haikuOutput: { body: 'MERGED BODY', supersedes: [betaPath] },
    autoApplyable: false,
    reason: 'test',
  }], { skill: 2 }, { generatedAt: '', sources: {}, proposals: [] });
  saveStore(store);
  const id = store.proposals[0].id;

  const result = applyProposal(id, { yes: true });
  t.diagnostic(`apply result: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, `apply should succeed: ${result.reason}`);
  assert.equal(readFileSync(alphaPath, 'utf8'), 'MERGED BODY');
  assert.equal(existsSync(betaPath), false, 'beta should be deleted as superseded source');

  // Status reflects applied.
  const after = loadStore();
  assert.equal(after.proposals.find(p => p.id === id).status, 'applied');
  assert.ok(result.bakDir, 'backup dir recorded');

  // Undo restores both files.
  const undone = undo({ last: true });
  assert.equal(undone.ok, true, `undo should succeed: ${undone.reason}`);
  assert.ok(undone.restored >= 2, `expected ≥ 2 files restored, got ${undone.restored}`);
  assert.equal(readFileSync(alphaPath, 'utf8'), 'original alpha body');
  assert.equal(readFileSync(betaPath, 'utf8'), 'original beta body');

  // Cleanup.
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});
