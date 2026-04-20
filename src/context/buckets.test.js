import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildBucketReport, estimateTokens, readLatestInputTokens } from './buckets.js';

function tempProject(content = {}) {
  const root = mkdtempSync(join(tmpdir(), 'setpoint-context-'));
  if (content.agents) {
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    for (const [name, body] of Object.entries(content.agents)) {
      writeFileSync(join(root, '.claude', 'agents', name), body);
    }
  }
  if (content.claudeMd) {
    writeFileSync(join(root, 'CLAUDE.md'), content.claudeMd);
  }
  return root;
}

test('estimateTokens returns 0 for empty input', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test('estimateTokens uses ~3.5 chars per token', () => {
  assert.equal(estimateTokens('x'.repeat(3500)), 1000);
  assert.equal(estimateTokens('x'.repeat(7000)), 2000);
});

test('buildBucketReport produces every required bucket', () => {
  const cwd = tempProject();
  const r = buildBucketReport({ cwd });
  const names = r.buckets.map(b => b.name);
  for (const required of [
    'System Prompt', 'System Tools', 'MCP Tools',
    'Custom Agents', 'Memory Files', 'Skills', 'Messages',
  ]) {
    assert.ok(names.includes(required), `missing bucket: ${required}`);
  }
});

test('buildBucketReport reports a positive freeSpace when buckets are small', () => {
  const cwd = tempProject();
  const r = buildBucketReport({ cwd, contextWindow: 200_000 });
  assert.ok(r.freeSpace > 0, `freeSpace should be > 0, got ${r.freeSpace}`);
  assert.ok(r.freeSpace + r.totalTokens + r.autocompactBuffer <= r.contextWindow + 5,
    'freeSpace + total + buffer must fit in window (±rounding)');
});

test('autocompactBuffer is ~16.5% of the context window', () => {
  const r = buildBucketReport({ cwd: tempProject(), contextWindow: 200_000 });
  assert.equal(r.autocompactBuffer, 33_000);
});

test('agent files inflate the Custom Agents bucket', () => {
  const cwdNoAgents = tempProject();
  const baseline = buildBucketReport({ cwd: cwdNoAgents });
  const baselineAgents = baseline.buckets.find(b => b.name === 'Custom Agents').tokens;

  const cwdWithAgents = tempProject({
    agents: { 'big.md': 'a'.repeat(35_000) }, // ~10K tokens
  });
  const fat = buildBucketReport({ cwd: cwdWithAgents });
  const fatAgents = fat.buckets.find(b => b.name === 'Custom Agents').tokens;

  assert.ok(fatAgents - baselineAgents >= 9000,
    `expected agents bucket to grow by ~10K, got ${fatAgents - baselineAgents}`);
});

test('readLatestInputTokens picks the most recent assistant turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'setpoint-context-jsonl-'));
  const path = join(root, 's.jsonl');
  const lines = [
    JSON.stringify({ message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 100, cache_read_input_tokens: 0 } } }),
    JSON.stringify({ message: { role: 'user', content: 'more' } }),
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 5000, cache_creation_input_tokens: 200, cache_read_input_tokens: 12_000 } } }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  assert.equal(readLatestInputTokens(path), 5000 + 200 + 12_000);
});

test('readLatestInputTokens returns null when no assistant turn exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'setpoint-context-jsonl-empty-'));
  const path = join(root, 's.jsonl');
  writeFileSync(path, JSON.stringify({ message: { role: 'user', content: 'hi' } }) + '\n');
  assert.equal(readLatestInputTokens(path), null);
});

test('Messages bucket equals input_tokens minus other buckets when transcript present', () => {
  const root = mkdtempSync(join(tmpdir(), 'setpoint-context-msg-'));
  const path = join(root, 's.jsonl');
  // input_tokens = 100_000 — leaves some after subtracting baselines.
  writeFileSync(path, JSON.stringify({
    message: { role: 'assistant', usage: { input_tokens: 100_000 } },
  }) + '\n');

  const r = buildBucketReport({ cwd: tempProject(), transcriptPath: path });
  const otherSum = r.buckets.filter(b => b.name !== 'Messages').reduce((a, b) => a + b.tokens, 0);
  const messages = r.buckets.find(b => b.name === 'Messages').tokens;
  assert.equal(messages + otherSum, 100_000, `messages + others must reconstruct input_tokens`);
});

test('Messages bucket clamps to 0 when other buckets exceed the transcript total', () => {
  const root = mkdtempSync(join(tmpdir(), 'setpoint-context-clamp-'));
  const path = join(root, 's.jsonl');
  writeFileSync(path, JSON.stringify({
    message: { role: 'assistant', usage: { input_tokens: 100 } },
  }) + '\n');

  const r = buildBucketReport({ cwd: tempProject(), transcriptPath: path });
  const messages = r.buckets.find(b => b.name === 'Messages').tokens;
  assert.equal(messages, 0, 'must not go negative');
});
