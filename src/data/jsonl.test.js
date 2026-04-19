import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { appendJsonl, readJsonl, readJsonlWindow, writeJsonAtomic, readJson, rotateJsonl } from './jsonl.js';

const TEST_DIR = join(tmpdir(), `jsonl-test-${randomBytes(4).toString('hex')}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('appendJsonl', () => {
  it('creates file and appends entry', () => {
    const path = join(TEST_DIR, 'append.jsonl');
    appendJsonl(path, { a: 1 });
    const content = readFileSync(path, 'utf8');
    assert.equal(content, '{"a":1}\n');
  });

  it('appends multiple entries', () => {
    const path = join(TEST_DIR, 'multi.jsonl');
    appendJsonl(path, { a: 1 });
    appendJsonl(path, { b: 2 });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
    assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  });

  it('creates parent directories', () => {
    const path = join(TEST_DIR, 'sub', 'dir', 'nested.jsonl');
    appendJsonl(path, { nested: true });
    assert.ok(existsSync(path));
  });
});

describe('readJsonl', () => {
  it('returns empty array for missing file', () => {
    assert.deepEqual(readJsonl(join(TEST_DIR, 'nope.jsonl')), []);
  });

  it('reads all entries', () => {
    const path = join(TEST_DIR, 'read.jsonl');
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":3}\n');
    const result = readJsonl(path);
    assert.equal(result.length, 3);
    assert.deepEqual(result[1], { b: 2 });
  });

  it('skips malformed lines', () => {
    const path = join(TEST_DIR, 'bad.jsonl');
    writeFileSync(path, '{"ok":1}\nNOT JSON\n{"ok":2}\n');
    const result = readJsonl(path);
    assert.equal(result.length, 2);
  });

  it('handles empty lines', () => {
    const path = join(TEST_DIR, 'empty.jsonl');
    writeFileSync(path, '{"a":1}\n\n\n{"b":2}\n');
    const result = readJsonl(path);
    assert.equal(result.length, 2);
  });
});

describe('readJsonlWindow', () => {
  it('filters entries by time window', () => {
    const path = join(TEST_DIR, 'window.jsonl');
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 3600_000); // 2h ago
    const recent = new Date(now.getTime() - 30 * 60_000); // 30m ago

    writeFileSync(path, [
      JSON.stringify({ ts: old.toISOString(), v: 'old' }),
      JSON.stringify({ ts: recent.toISOString(), v: 'recent' }),
    ].join('\n') + '\n');

    const result = readJsonlWindow(path, 3600_000); // 1h window
    assert.equal(result.length, 1);
    assert.equal(result[0].v, 'recent');
  });

  it('returns empty for missing file', () => {
    assert.deepEqual(readJsonlWindow(join(TEST_DIR, 'nope.jsonl'), 3600_000), []);
  });
});

describe('writeJsonAtomic', () => {
  it('writes JSON atomically', () => {
    const path = join(TEST_DIR, 'atomic.json');
    writeJsonAtomic(path, { key: 'value' });
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(result, { key: 'value' });
  });

  it('overwrites existing file', () => {
    const path = join(TEST_DIR, 'overwrite.json');
    writeJsonAtomic(path, { v: 1 });
    writeJsonAtomic(path, { v: 2 });
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(result.v, 2);
  });
});

describe('readJson', () => {
  it('returns null for missing file', () => {
    assert.equal(readJson(join(TEST_DIR, 'nope.json')), null);
  });

  it('reads valid JSON', () => {
    const path = join(TEST_DIR, 'valid.json');
    writeFileSync(path, '{"x": 42}');
    assert.deepEqual(readJson(path), { x: 42 });
  });

  it('returns null for invalid JSON', () => {
    const path = join(TEST_DIR, 'invalid.json');
    writeFileSync(path, 'not json');
    assert.equal(readJson(path), null);
  });
});

describe('rotateJsonl', () => {
  it('does nothing for missing file', () => {
    assert.equal(rotateJsonl(join(TEST_DIR, 'nope.jsonl'), 1000, 5), false);
  });

  it('does nothing when file is under maxBytes', () => {
    const path = join(TEST_DIR, 'small.jsonl');
    writeFileSync(path, '{"a":1}\n');
    assert.equal(rotateJsonl(path, 100_000, 5), false);
  });

  it('rotates when file exceeds maxBytes', () => {
    const path = join(TEST_DIR, 'big.jsonl');
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ i, padding: 'x'.repeat(50) }));
    }
    writeFileSync(path, lines.join('\n') + '\n');

    const result = rotateJsonl(path, 500, 10); // keep last 10
    assert.equal(result, true);

    const kept = readJsonl(path);
    assert.equal(kept.length, 10);
    assert.equal(kept[0].i, 90); // first kept is entry 90
    assert.equal(kept[9].i, 99); // last kept is entry 99
  });

  it('keeps all lines when keepLines exceeds total', () => {
    const path = join(TEST_DIR, 'few.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ i, padding: 'x'.repeat(100) }));
    }
    writeFileSync(path, lines.join('\n') + '\n');

    const result = rotateJsonl(path, 100, 1000); // keep more than exists
    assert.equal(result, true);

    const kept = readJsonl(path);
    assert.equal(kept.length, 5); // all kept
  });
});
