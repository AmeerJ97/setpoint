import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenize,
  tokenCounts,
  chunk,
  jaccard,
  bm25Score,
  loadProfiles,
  matchProfile,
  computeDrift,
  analyzeIntent,
} from './semantic-engine.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'claude-ops-sem-'));
}

test('tokenize lowercases, dedupes, drops stopwords + short tokens', () => {
  const tokens = tokenize('The Quick brown FOX jumps and the Fox again');
  assert.ok(tokens.has('quick'));
  assert.ok(tokens.has('brown'));
  assert.ok(tokens.has('fox'));
  assert.ok(tokens.has('jumps'));
  assert.ok(tokens.has('again'));
  assert.ok(!tokens.has('the'));
  assert.ok(!tokens.has('and'));
});

test('tokenize returns empty set for empty / falsy input', () => {
  assert.equal(tokenize('').size, 0);
  assert.equal(tokenize(null).size, 0);
  assert.equal(tokenize(undefined).size, 0);
});

test('chunk takes first BEG_SIZE and last END_SIZE after strip', () => {
  const text = `${'a'.repeat(1000)}   middle   ${'b'.repeat(1000)}`;
  const { beg, end } = chunk(`   \n${text}\t  `);
  assert.equal(beg.length, 512);
  assert.equal(end.length, 512);
  assert.ok(beg.startsWith('a'));
  assert.ok(end.endsWith('b'));
});

test('chunk handles short input without crash', () => {
  const { beg, end } = chunk('short');
  assert.equal(beg, 'short');
  assert.equal(end, 'short');
});

test('jaccard: identical sets = 1, disjoint = 0, subset = |small|/|large|', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(['a']), new Set(['a', 'b'])), 0.5);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
});

test('tokenCounts returns multiset frequencies and total length', () => {
  const { counts, length } = tokenCounts('refactor refactor debug test test test');
  assert.equal(counts.get('refactor'), 2);
  assert.equal(counts.get('debug'), 1);
  assert.equal(counts.get('test'), 3);
  assert.equal(length, 6);
});

test('loadProfiles returns empty corpus on missing/empty dir (no mocks)', () => {
  const dir = tmp();
  try {
    const corpus = loadProfiles(dir);
    assert.equal(corpus.N, 0);
    assert.equal(corpus.avgdl, 0);
    assert.equal(corpus.profiles.size, 0);
    const empty = loadProfiles(join(dir, 'does-not-exist'));
    assert.equal(empty.N, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadProfiles builds BM25 corpus from real hook frontmatter + body', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'x.md'), [
      '---',
      'name: test-skill-compile',
      'kind: fsm',
      'trigger:',
      '  edits_session_min: 5',
      'priority: 50',
      'cooldown_min: 15',
      '---',
      'Sample body mentions refactor and verification loop explicitly.',
    ].join('\n'));
    const corpus = loadProfiles(dir);
    assert.equal(corpus.N, 1);
    assert.ok(corpus.avgdl > 0);
    const doc = corpus.profiles.get('test-skill-compile');
    assert.ok(doc);
    assert.ok(doc.tokens.has('refactor'));
    assert.ok(doc.tokens.has('verification'));
    assert.ok(doc.tokens.has('fsm'));
    assert.ok(doc.counts.get('refactor') >= 1);
    assert.equal(corpus.df.get('refactor'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bm25Score: rare tokens outweigh common ones (IDF working)', () => {
  const dir = tmp();
  try {
    // Common token "edit" appears in BOTH docs; rare token "adversarial"
    // in only ONE. A query mixing both should prefer the doc with the
    // rare term.
    writeFileSync(join(dir, 'a.md'), [
      '---', 'name: doc-a', 'kind: reminder', 'trigger:', '  x_min: 1',
      'priority: 50', 'cooldown_min: 15', '---',
      'edit edit edit adversarial review important gate',
    ].join('\n'));
    writeFileSync(join(dir, 'b.md'), [
      '---', 'name: doc-b', 'kind: reminder', 'trigger:', '  x_min: 1',
      'priority: 50', 'cooldown_min: 15', '---',
      'edit edit edit common plain mundane verbose',
    ].join('\n'));
    const corpus = loadProfiles(dir);
    const q = new Set(['edit', 'adversarial', 'review']);
    const a = bm25Score(q, corpus.profiles.get('doc-a'), corpus);
    const b = bm25Score(q, corpus.profiles.get('doc-b'), corpus);
    assert.ok(a > b, `rare-token doc should score higher: a=${a} b=${b}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('matchProfile returns null for empty corpus or tiny chunks', () => {
  const tokens = tokenize('one two three four');
  assert.equal(matchProfile(tokens, { profiles: new Map(), df: new Map(), N: 0, avgdl: 0 }), null);
  const corpus = {
    profiles: new Map([['x', { counts: new Map([['one', 1]]), tokens: new Set(['one']), length: 1 }]]),
    df: new Map([['one', 1]]),
    N: 1,
    avgdl: 1,
  };
  assert.equal(matchProfile(new Set(['x']), corpus), null);
});

test('matchProfile picks highest-scoring profile', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'code.md'), [
      '---', 'name: code', 'kind: fsm', 'trigger:', '  x_min: 1',
      'priority: 50', 'cooldown_min: 15', '---',
      'refactor debug edit test function module class',
    ].join('\n'));
    writeFileSync(join(dir, 'docs.md'), [
      '---', 'name: docs', 'kind: reminder', 'trigger:', '  x_min: 1',
      'priority: 50', 'cooldown_min: 15', '---',
      'readme markdown prose writeup paragraph section heading',
    ].join('\n'));
    const corpus = loadProfiles(dir);
    const tokens = tokenize('refactor this debug edit test function');
    const best = matchProfile(tokens, corpus);
    assert.ok(best);
    assert.equal(best.name, 'code');
    assert.ok(best.score > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('computeDrift: identical chunks → 0, disjoint → 1, no prev → 0', () => {
  const a = new Set(['x', 'y', 'z']);
  const b = new Set(['p', 'q', 'r']);
  assert.equal(computeDrift(a, a), 0);
  assert.equal(computeDrift(a, b), 1);
  assert.equal(computeDrift(a, null), 0);
  assert.equal(computeDrift(a, new Set()), 0);
});

test('analyzeIntent returns honest empty when no profiles + no persistence', () => {
  const dir = tmp();
  try {
    const statePath = join(dir, 'state.json');
    const emptyHooks = join(dir, 'hooks'); mkdirSync(emptyHooks);
    const result = analyzeIntent({
      text: 'refactor this function with debug logs',
      profiles: loadProfiles(emptyHooks),
      statePath,
      persist: false,
    });
    assert.equal(result.topSkill, null);
    assert.equal(result.matchScore, 0);
    assert.equal(result.drift, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('analyzeIntent persists state and drift drops on similar text', () => {
  const dir = tmp();
  try {
    const hooksDir = join(dir, 'hooks'); mkdirSync(hooksDir);
    const statePath = join(dir, 'state.json');
    writeFileSync(join(hooksDir, 'code-work.md'), [
      '---', 'name: code-work', 'kind: fsm', 'trigger:', '  x_min: 1',
      'priority: 50', 'cooldown_min: 15', '---',
      'refactor debug edit test function module',
    ].join('\n'));
    const profiles = loadProfiles(hooksDir);

    const r1 = analyzeIntent({ text: 'refactor debug edit test function', profiles, statePath });
    assert.equal(r1.topSkill, 'code-work');
    assert.equal(r1.drift, 0); // first tick has no previous

    const r2 = analyzeIntent({ text: 'refactor debug edit test function again here', profiles, statePath });
    assert.ok(r2.drift < 0.4, `expected small drift on similar text, got ${r2.drift}`);

    const r3 = analyzeIntent({ text: 'prose writing blog post markdown paragraph', profiles, statePath });
    assert.ok(r3.drift > 0.5, `expected large drift on divergent text, got ${r3.drift}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('microbench: analyzeIntent under 10ms per call on realistic text', () => {
  const dir = tmp();
  try {
    const statePath = join(dir, 'state.json');
    const profiles = loadProfiles(); // real config/hooks/
    const text = 'Read src/a.js Edit src/a.js Bash npm test Grep TODO Glob **/*.ts Write out.txt '.repeat(20);
    // Warmup
    for (let i = 0; i < 3; i++) analyzeIntent({ text, profiles, statePath, persist: false });
    const start = process.hrtime.bigint();
    const iters = 50;
    for (let i = 0; i < iters; i++) {
      analyzeIntent({ text, profiles, statePath, persist: false });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perCallMs = elapsedMs / iters;
    assert.ok(perCallMs < 10, `analyzeIntent too slow: ${perCallMs.toFixed(2)}ms/call`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
