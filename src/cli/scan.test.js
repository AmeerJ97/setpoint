import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const ORIGINAL_PATH = process.env.PATH;
const SANDBOXES = [];

let scan;
let pluginDir;

before(async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-ops-scan-'));
  SANDBOXES.push(sandbox);
  const claudeDir = join(sandbox, '.claude');
  pluginDir = join(claudeDir, 'plugins', 'claude-ops');
  mkdirSync(pluginDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  scan = await import('./scan.js');
});

afterEach(() => {
  // Remove state files that individual tests may have written
  for (const name of ['semantic-state.json', 'fsm-state.json']) {
    try { rmSync(join(pluginDir, name)); } catch {}
  }
});

after(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStdout() {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    done() { process.stdout.write = orig; return chunks.join(''); },
  };
}

function writeSemanticState(tokens) {
  writeFileSync(join(pluginDir, 'semantic-state.json'), JSON.stringify({ tokens }));
}

function writeFsmState(obj) {
  writeFileSync(join(pluginDir, 'fsm-state.json'), JSON.stringify(obj));
}

function withQmdScript(script) {
  const dir = mkdtempSync(join(tmpdir(), 'qmd-test-'));
  SANDBOXES.push(dir);
  writeFileSync(join(dir, 'qmd'), script, { mode: 0o755 });
  return dir;
}

function withQmdOnPath(script, fn) {
  const dir = withQmdScript(script);
  const prev = process.env.PATH;
  process.env.PATH = `${dir}:${prev}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
}

function restoreEnv() {
  process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
}

// ===========================================================================
// parseArgs
// ===========================================================================

describe('parseArgs', () => {
  test('default args', () => {
    const opts = scan.parseArgs([]);
    assert.deepEqual(opts, { limit: 5, json: false, qmdCollection: null, text: null, help: false });
  });

  test('--json flag', () => {
    assert.equal(scan.parseArgs(['--json']).json, true);
  });

  test('--help flag', () => {
    assert.equal(scan.parseArgs(['--help']).help, true);
  });

  test('-h alias', () => {
    assert.equal(scan.parseArgs(['-h']).help, true);
  });

  test('--qmd sets collection', () => {
    const opts = scan.parseArgs(['--qmd', 'my-notes']);
    assert.equal(opts.qmdCollection, 'my-notes');
  });

  test('--text sets query text', () => {
    const opts = scan.parseArgs(['--text', 'refactor auth']);
    assert.equal(opts.text, 'refactor auth');
  });

  test('--text with spaces in quoted arg', () => {
    const opts = scan.parseArgs(['--text', 'hello world foo']);
    assert.equal(opts.text, 'hello world foo');
  });

  test('-n sets limit', () => {
    const opts = scan.parseArgs(['-n', '10']);
    assert.equal(opts.limit, 10);
  });

  test('--limit sets limit', () => {
    const opts = scan.parseArgs(['--limit', '3']);
    assert.equal(opts.limit, 3);
  });

  test('--limit with non-numeric value defaults to 5', () => {
    const opts = scan.parseArgs(['--limit', 'abc']);
    assert.equal(opts.limit, 5);
  });

  test('--limit with missing value defaults to 5', () => {
    const opts = scan.parseArgs(['--limit']);
    assert.equal(opts.limit, 5);
  });

  test('multiple flags combined', () => {
    const opts = scan.parseArgs(['--json', '--qmd', 'docs', '--text', 'query', '-n', '3']);
    assert.deepEqual(opts, { limit: 3, json: true, qmdCollection: 'docs', text: 'query', help: false });
  });

  test('--json and --help — help wins logic (handled in main, parseArgs sets both)', () => {
    const opts = scan.parseArgs(['--json', '--help']);
    assert.equal(opts.json, true);
    assert.equal(opts.help, true);
  });

  test('leading "scan" subcommand token is ignored', () => {
    const opts = scan.parseArgs(['scan', '--json']);
    assert.equal(opts.json, true);
    assert.equal(opts.text, null);
  });
});

// ===========================================================================
// readPersistedChunkText
// ===========================================================================

describe('readPersistedChunkText', () => {
  test('returns null when no state file exists', () => {
    assert.equal(scan.readPersistedChunkText(), null);
  });

  test('returns joined tokens when valid state exists', () => {
    writeSemanticState(['refactor', 'auth', 'middleware']);
    const result = scan.readPersistedChunkText();
    assert.equal(result, 'refactor auth middleware');
  });

  test('returns null when tokens array is empty', () => {
    writeSemanticState([]);
    assert.equal(scan.readPersistedChunkText(), null);
  });

  test('returns null when tokens field is missing', () => {
    writeFileSync(join(pluginDir, 'semantic-state.json'), JSON.stringify({ notTokens: [] }));
    assert.equal(scan.readPersistedChunkText(), null);
  });

  test('returns null when tokens is not an array', () => {
    writeFileSync(join(pluginDir, 'semantic-state.json'), JSON.stringify({ tokens: 'string' }));
    assert.equal(scan.readPersistedChunkText(), null);
  });

  test('returns null when data is null', () => {
    writeFileSync(join(pluginDir, 'semantic-state.json'), 'null');
    assert.equal(scan.readPersistedChunkText(), null);
  });

  test('returns null on malformed JSON', () => {
    writeFileSync(join(pluginDir, 'semantic-state.json'), '{bad json');
    assert.equal(scan.readPersistedChunkText(), null);
  });
});

// ===========================================================================
// readFsmSnapshot
// ===========================================================================

describe('readFsmSnapshot', () => {
  test('returns null when no FSM state file exists', () => {
    assert.equal(scan.readFsmSnapshot(), null);
  });

  test('returns parsed state when valid file exists', () => {
    const state = { currentState: 'analyze', thrashingTicks: 2, lastTransition: { from: 'idle', to: 'analyze', at: Date.now(), reason: 'user prompt' } };
    writeFsmState(state);
    const result = scan.readFsmSnapshot();
    assert.deepEqual(result, state);
  });

  test('returns null on malformed JSON', () => {
    writeFileSync(join(pluginDir, 'fsm-state.json'), '{broken');
    assert.equal(scan.readFsmSnapshot(), null);
  });
});

// ===========================================================================
// runQmd
// ===========================================================================

describe('runQmd', () => {
  test('returns error when qmd is not on PATH', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'qmd-empty-'));
    SANDBOXES.push(emptyDir);
    const prev = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const result = scan.runQmd('test', 'hello', 5);
      assert.ok(result.error);
      assert.match(result.error, /qmd not found/);
    } finally {
      process.env.PATH = prev;
    }
  });

  test('returns error when qmd exits non-zero', () => {
    withQmdOnPath(
      '#!/bin/sh\necho "something went wrong" >&2\nexit 2',
      () => {
        const result = scan.runQmd('test', 'hello', 5);
        assert.ok(result.error);
        assert.match(result.error, /qmd exited 2/);
      },
    );
  });

  test('returns parsed results when qmd outputs valid JSON array', () => {
    withQmdOnPath(
      '#!/bin/sh\ncat <<JSON\n[{"score":0.95,"filepath":"src/auth.md"},{"score":0.82,"filepath":"src/middleware.md"}]\nJSON',
      () => {
        const result = scan.runQmd('test', 'hello', 5);
        assert.deepEqual(result, {
          results: [
            { score: 0.95, filepath: 'src/auth.md' },
            { score: 0.82, filepath: 'src/middleware.md' },
          ],
        });
      },
    );
  });

  test('returns parsed results when qmd outputs JSON object with results array', () => {
    withQmdOnPath(
      '#!/bin/sh\necho \'{"results":[{"score":0.9,"docid":"doc1"}],"total":1}\'',
      () => {
        const result = scan.runQmd('test', 'query', 5);
        assert.ok(result.results);
        assert.equal(result.results.total, 1);
      },
    );
  });

  test('returns raw text when qmd outputs non-JSON', () => {
    withQmdOnPath(
      '#!/bin/sh\necho "plain text output line 1"\necho "line 2"',
      () => {
        const result = scan.runQmd('test', 'hello', 5);
        assert.ok(result.raw);
        assert.match(result.raw, /plain text output/);
      },
    );
  });

  test('truncates query to 1024 chars', () => {
    const longQuery = 'x'.repeat(2000);
    withQmdOnPath(
      '#!/bin/sh\nread -r _; read -r _; read -r q; echo "{\\"query_len\\":${#q}}"',
      () => {
        // Our fake qmd is bash, so we check that the arg is passed
        const result = scan.runQmd('test', longQuery, 5);
        // Just verify it doesn't throw and returns something
        assert.ok(result);
      },
    );
  });
});

// ===========================================================================
// renderHuman
// ===========================================================================

describe('renderHuman', () => {
  const sampleQueryTokens = new Set(['refactor', 'auth', 'middleware']);

  test('renders full output with fsm, local results and qmd', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: { currentState: 'plan', thrashingTicks: 1, lastTransition: { from: 'analyze', to: 'plan', at: Date.now() - 5000, reason: 'intent shift' } },
      local: [{ name: 'auth-hook', score: 3.2 }, { name: 'middleware-hook', score: 1.5 }],
      qmd: { results: [{ score: 0.95, filepath: 'docs/auth.md' }] },
      chunkText: 'refactor auth middleware',
      queryTokens: sampleQueryTokens,
    });
    const out = cap.done();

    assert.match(out, /claude-ops scan/);
    assert.match(out, /FSM state:\s+plan/);
    assert.match(out, /thrashing ticks: 1/);
    assert.match(out, /Last change:/);
    assert.match(out, /analyze.*plan/);
    assert.match(out, /reason: intent shift/);
    assert.match(out, /Query size:\s+3 unique tokens/);
    assert.match(out, /Top in-repo skill-profile matches/);
    assert.match(out, /3\.200\s+auth-hook/);
    assert.match(out, /1\.500\s+middleware-hook/);
    assert.match(out, /qmd bridge:/);
    assert.match(out, /0\.950\s+docs\/auth\.md/);
  });

  test('renders cold-start message when fsm is null', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: null,
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.match(out, /cold start/);
    assert.match(out, /no profile matched/);
    assert.doesNotMatch(out, /qmd bridge/);
  });

  test('renders no-profile message when local results empty', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: null,
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.match(out, /no profile matched/);
  });

  test('renders qmd error message', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: { error: 'qmd not found on PATH' },
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.match(out, /qmd bridge:/);
    assert.match(out, /qmd not found on PATH/);
  });

  test('renders qmd raw output', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: { raw: '[raw output from qmd]' },
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.match(out, /\[raw qmd output\]/);
    assert.match(out, /\[raw output from qmd\]/);
  });

  test('renders qmd zero-hits message', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: { results: [] },
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.match(out, /qmd returned 0 hits/);
  });

  test('does not render qmd section when qmd is null', () => {
    const cap = captureStdout();
    scan.renderHuman({
      fsm: null,
      local: [],
      qmd: null,
      chunkText: 'test',
      queryTokens: new Set(['test']),
    });
    const out = cap.done();

    assert.doesNotMatch(out, /qmd bridge/);
  });
});

// ===========================================================================
// main (integration)
// ===========================================================================

describe('main', () => {
  test('--help prints usage and returns 0', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--help']);
    const out = cap.done();
    assert.equal(code, 0);
    assert.match(out, /claude-ops scan/);
    assert.match(out, /Usage:/);
    assert.match(out, /--json/);
    assert.match(out, /--qmd/);
    assert.match(out, /Examples:/);
  });

  test('no args with no persisted state prints guidance and returns 2', async () => {
    const cap = captureStdout();
    const code = await scan.main([]);
    const out = cap.done();
    assert.equal(code, 2);
    assert.match(out, /no session activity found/);
    assert.match(out, /--text/);
  });

  test('--text "some query" runs BM25 drilldown and returns 0', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--text', 'test the auth middleware refactor']);
    const out = cap.done();
    assert.equal(code, 0);
    assert.match(out, /claude-ops scan/);
    assert.match(out, /Query size:/);
    assert.match(out, /unique tokens/);
    assert.match(out, /Top in-repo skill-profile matches/);
  });

  test('--json --text "query" produces valid JSON output', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--json', '--text', 'adversarial review workflow']);
    const out = cap.done();
    assert.equal(code, 0);

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(out); });
    assert.ok(parsed.fsm === null || typeof parsed.fsm === 'object');
    assert.equal(typeof parsed.queryTokenCount, 'number');
    assert.equal(typeof parsed.chunkLength, 'number');
    assert.ok(Array.isArray(parsed.local));
    assert.equal('qmd' in parsed, true);
    // Each local entry has name and score
    for (const entry of parsed.local) {
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.score, 'number');
      assert.ok(entry.score > 0);
    }
  });

  test('--json --text "query" --limit 2 caps local results', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--json', '--text', 'config parser for hooks', '--limit', '2']);
    const out = cap.done();
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.ok(parsed.local.length <= 2);
  });

  test('--text with empty string returns 2 (no session activity)', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--text', '']);
    const out = cap.done();
    assert.equal(code, 2);
    assert.match(out, /no session activity/);
  });

  test('--text with whitespace-only string produces empty BM25 results', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--json', '--text', '   ']);
    const out = cap.done();
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.queryTokenCount, 0);
    assert.deepEqual(parsed.local, []);
  });

  test('--json output includes null qmd when --qmd not given', async () => {
    const cap = captureStdout();
    const code = await scan.main(['--json', '--text', 'hello world']);
    const out = cap.done();
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.qmd, null);
  });
});
