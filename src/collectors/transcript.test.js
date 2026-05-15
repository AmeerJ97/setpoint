import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = mkdtempSync(join(tmpdir(), 'claude-ops-transcript-'));
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, '.claude');

const paths = await import('../data/paths.js');
const { parseTranscript } = await import('./transcript.js');

before(() => {
  mkdirSync(paths.TRANSCRIPT_CACHE_DIR, { recursive: true });
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function toolLine(timestamp, id, name, input, type, role) {
  const entry = {
    timestamp,
    type: type ?? 'assistant',
    message: { role: role ?? 'assistant', content: [{ type: 'tool_use', id, name }] },
  };
  if (input && Object.keys(input).length) entry.message.content[0].input = input;
  return JSON.stringify(entry) + '\n';
}

function toolResultLine(timestamp, toolUseId, isError) {
  return JSON.stringify({
    timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: !!isError }],
    },
  }) + '\n';
}

function jsonl(...objects) {
  return objects.map(o => JSON.stringify(o)).join('\n') + '\n';
}

const EMPTY = { tools: [], agents: [], todos: [], sessionStart: undefined, sessionName: undefined, reversalCount: 0, toolCallCount: 0, cchHashMutationCount: 0, quotaEvents: [] };

function assertResultStructure(r) {
  assert.ok(Array.isArray(r.tools));
  assert.ok(Array.isArray(r.agents));
  assert.ok(Array.isArray(r.todos));
  assert.ok(Array.isArray(r.quotaEvents));
  assert.equal(typeof r.reversalCount, 'number');
  assert.equal(typeof r.toolCallCount, 'number');
  assert.equal(typeof r.cchHashMutationCount, 'number');
}

describe('parseTranscript — edge cases', () => {
  it('returns empty structure for null path', async () => {
    const r = await parseTranscript(null);
    assertResultStructure(r);
    assert.equal(r.toolCallCount, 0);
    assert.equal(r.tools.length, 0);
  });

  it('returns empty structure for undefined path', async () => {
    const r = await parseTranscript(undefined);
    assertResultStructure(r);
    assert.equal(r.toolCallCount, 0);
  });

  it('returns empty structure for empty string path', async () => {
    const r = await parseTranscript('');
    assertResultStructure(r);
    assert.equal(r.toolCallCount, 0);
  });

  it('returns empty structure for non-existent path', async () => {
    const r = await parseTranscript(join(SANDBOX, 'does-not-exist.jsonl'));
    assertResultStructure(r);
    assert.deepEqual(r.tools, []);
  });

  it('returns empty structure for a directory path', async () => {
    const r = await parseTranscript(SANDBOX);
    assertResultStructure(r);
    assert.deepEqual(r.tools, []);
    assert.equal(r.toolCallCount, 0);
  });

  it('returns empty structure for empty file', async () => {
    const f = join(SANDBOX, 'empty.jsonl');
    writeFileSync(f, '');
    const r = await parseTranscript(f);
    assert.deepEqual(r, EMPTY);
  });

  it('handles file with only blank lines', async () => {
    const f = join(SANDBOX, 'blanks.jsonl');
    writeFileSync(f, '\n\n\n\n');
    const r = await parseTranscript(f);
    assert.deepEqual(r, EMPTY);
  });

  it('handles plain text file (not JSONL)', async () => {
    const f = join(SANDBOX, 'plain.txt');
    writeFileSync(f, 'This is not JSON\nStill not JSON\ncch=somehash\n');
    const r = await parseTranscript(f);
    assert.equal(r.cchHashMutationCount, 1);
    assert.equal(r.toolCallCount, 0);
    assert.equal(r.quotaEvents.length, 0);
  });

  it('skips malformed JSON lines', async () => {
    const f = join(SANDBOX, 'malformed.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read', { file_path: 'a.js' }) +
      '{this is not valid json}\n' +
      'also not json\n' +
      toolLine('2026-05-09T10:00:02Z', 't2', 'Write')
    );
    const r = await parseTranscript(f);
    assert.equal(r.tools.length, 2);
    assert.equal(r.toolCallCount, 2);
  });

  it('skips entries without message.content', async () => {
    const f = join(SANDBOX, 'no-content.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: {} },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant' },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant' } },
      { timestamp: '2026-05-09T10:00:03Z', type: 'assistant', message: { role: 'assistant', content: 'not-an-array' } },
    ));
    const r = await parseTranscript(f);
    assert.equal(r.toolCallCount, 0);
    assert.equal(r.tools.length, 0);
  });

  it('skips tool_use blocks missing id or name', async () => {
    const f = join(SANDBOX, 'partial-tool.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'NoId' }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3' }] } },
    ));
    const r = await parseTranscript(f);
    assert.equal(r.toolCallCount, 1);
    assert.equal(r.tools.length, 1);
  });
});

describe('parseTranscript — tools', () => {
  it('extracts tool_use entries into tools array', async () => {
    const f = join(SANDBOX, 'tools-basic.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read', { file_path: 'a.js' }) +
      toolLine('2026-05-09T10:00:01Z', 't2', 'Write', { path: 'b.js' }) +
      toolLine('2026-05-09T10:00:02Z', 't3', 'Bash', { command: 'npm test' })
    );
    const r = await parseTranscript(f);
    assert.equal(r.tools.length, 3);
    assert.equal(r.toolCallCount, 3);
    assert.equal(r.tools[0].id, 't1');
    assert.equal(r.tools[0].name, 'Read');
    assert.equal(r.tools[0].target, 'a.js');
    assert.equal(r.tools[0].status, 'running');
    assert.ok(r.tools[0].startTime instanceof Date);
    assert.equal(r.tools[1].name, 'Write');
    assert.equal(r.tools[1].target, 'b.js');
    assert.equal(r.tools[2].name, 'Bash');
    assert.equal(r.tools[2].target, 'npm test');
  });

  it('updates tool status from tool_result blocks', async () => {
    const f = join(SANDBOX, 'tool-status.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read', { file_path: 'a.js' }) +
      toolLine('2026-05-09T10:00:01Z', 't2', 'Glob', { pattern: '*.js' }) +
      toolLine('2026-05-09T10:00:02Z', 't3', 'Grep', { pattern: 'TODO' }) +
      toolResultLine('2026-05-09T10:00:10Z', 't1', false) +
      toolResultLine('2026-05-09T10:00:11Z', 't2', true)
    );
    const r = await parseTranscript(f);
    assert.equal(r.tools[0].status, 'completed');
    assert.ok(r.tools[0].endTime instanceof Date);
    assert.equal(r.tools[1].status, 'error');
    assert.ok(r.tools[1].endTime instanceof Date);
    assert.equal(r.tools[2].status, 'running'); // no result
    assert.equal(r.tools[2].endTime, undefined);
  });

  it('sets tool target for all known tool names', async () => {
    const f = join(SANDBOX, 'tool-targets.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'src/index.js' } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { path: 'dest.js' } }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'src/edit.js' } }] } },
      { timestamp: '2026-05-09T10:00:03Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'Glob', input: { pattern: '**/*.ts' } }] } },
      { timestamp: '2026-05-09T10:00:04Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'gr1', name: 'Grep', input: { pattern: 'function' } }] } },
      { timestamp: '2026-05-09T10:00:05Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build -- --long-flag --verbose' } }] } },
      { timestamp: '2026-05-09T10:00:06Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'UnknownTool', input: { something: 'x' } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.tools[0].target, 'src/index.js');
    assert.equal(r.tools[1].target, 'dest.js');
    assert.equal(r.tools[2].target, 'src/edit.js');
    assert.equal(r.tools[3].target, '**/*.ts');
    assert.equal(r.tools[4].target, 'function');
    assert.equal(r.tools[5].target, 'npm run build -- --long-flag -...');
    assert.equal(r.tools[6].target, undefined);
  });

  it('handles multiple tool_use blocks in a single message', async () => {
    const f = join(SANDBOX, 'multi-tool.jsonl');
    writeFileSync(f, JSON.stringify({
      timestamp: '2026-05-09T10:00:00Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'm1', name: 'Read', input: { file_path: 'a.js' } },
          { type: 'tool_use', id: 'm2', name: 'Write', input: { file_path: 'b.js' } },
          { type: 'tool_result', tool_use_id: 'm1', is_error: false },
          { type: 'tool_result', tool_use_id: 'm2', is_error: true },
        ],
      },
    }) + '\n');
    const r = await parseTranscript(f);
    assert.equal(r.toolCallCount, 2);
    assert.equal(r.tools.length, 2);
    assert.equal(r.tools[0].status, 'completed');
    assert.equal(r.tools[1].status, 'error');
  });

  it('counts tool calls accurately across all entries', async () => {
    const f = join(SANDBOX, 'tool-count.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({
        timestamp: `2026-05-09T10:00:0${i}Z`,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read' }] },
      }));
    }
    writeFileSync(f, lines.join('\n') + '\n');
    const r = await parseTranscript(f);
    assert.equal(r.toolCallCount, 5);
    assert.equal(r.tools.length, 5);
  });

  it('slices tools array to last 20', async () => {
    const f = join(SANDBOX, 'tool-slice.jsonl');
    const lines = [];
    for (let i = 0; i < 25; i++) {
      lines.push(JSON.stringify({
        timestamp: `2026-05-09T10:00:${String(i).padStart(2, '0')}Z`,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Read' }] },
      }));
    }
    writeFileSync(f, lines.join('\n') + '\n');
    const r = await parseTranscript(f);
    assert.equal(r.tools.length, 20);
    assert.equal(r.tools[0].id, 'tool-5');
    assert.equal(r.tools[19].id, 'tool-24');
    assert.equal(r.toolCallCount, 25); // full count preserved
  });
});

describe('parseTranscript — agents', () => {
  it('tracks Task and Agent tool_use as agents', async () => {
    const f = join(SANDBOX, 'agents.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'general', model: 'sonnet', description: 'do work' } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a2', name: 'Agent', input: { subagent_type: 'code', description: 'write code' } }] } },
      { timestamp: '2026-05-09T10:00:05Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'a1' }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.agents.length, 2);
    assert.equal(r.agents[0].id, 'a1');
    assert.equal(r.agents[0].type, 'general');
    assert.equal(r.agents[0].model, 'sonnet');
    assert.equal(r.agents[0].description, 'do work');
    assert.equal(r.agents[0].status, 'completed');
    assert.ok(r.agents[0].endTime instanceof Date);
    assert.equal(r.agents[1].id, 'a2');
    assert.equal(r.agents[1].type, 'code');
    assert.equal(r.agents[1].description, 'write code');
    assert.equal(r.agents[1].status, 'running');
    assert.equal(r.agents[1].endTime, undefined);
  });

  it('defaults subagent_type to "unknown" when missing', async () => {
    const f = join(SANDBOX, 'agent-no-type.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: {} }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.agents.length, 1);
    assert.equal(r.agents[0].type, 'unknown');
  });

  it('slices agents array to last 10', async () => {
    const f = join(SANDBOX, 'agent-slice.jsonl');
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({
        timestamp: `2026-05-09T10:00:${String(i).padStart(2, '0')}Z`,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `agt-${i}`, name: 'Task', input: { subagent_type: 'general' } }] },
      }));
    }
    writeFileSync(f, lines.join('\n') + '\n');
    const r = await parseTranscript(f);
    assert.equal(r.agents.length, 10);
    assert.equal(r.agents[0].id, 'agt-5');
    assert.equal(r.agents[9].id, 'agt-14');
  });
});

describe('parseTranscript — todos', () => {
  it('TodoWrite replaces the entire todo list', async () => {
    const f = join(SANDBOX, 'todo-write.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'First', status: 'pending' }, { content: 'Second', status: 'in_progress' }] } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.todos.length, 2);
    assert.equal(r.todos[0].content, 'First');
    assert.equal(r.todos[0].status, 'pending');
    assert.equal(r.todos[1].content, 'Second');
    assert.equal(r.todos[1].status, 'in_progress');
  });

  it('TodoWrite replaces previous todos', async () => {
    const f = join(SANDBOX, 'todo-replace.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'Old', status: 'pending' }] } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw2', name: 'TodoWrite', input: { todos: [{ content: 'New', status: 'completed' }] } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0].content, 'New');
  });

  it('TaskCreate adds a todo with normalized status', async () => {
    const f = join(SANDBOX, 'task-create.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc1', name: 'TaskCreate', input: { subject: 'Do thing', status: 'not_started', taskId: '1' } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc2', name: 'TaskCreate', input: { description: 'Another task', status: 'running', taskId: '2' } }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tc3', name: 'TaskCreate', input: { subject: 'Untitled task' } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.todos.length, 3);
    assert.equal(r.todos[0].content, 'Do thing');
    assert.equal(r.todos[0].status, 'pending');
    assert.equal(r.todos[1].content, 'Another task');
    assert.equal(r.todos[1].status, 'in_progress');
    assert.equal(r.todos[2].content, 'Untitled task');
    assert.equal(r.todos[2].status, 'pending');
  });

  it('TaskUpdate modifies task status and content by index or mapping', async () => {
    const f = join(SANDBOX, 'task-update.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'Task A', status: 'pending' }, { content: 'Task B', status: 'pending' }] } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '1', status: 'done', subject: 'Task A Updated' } }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.todos[0].content, 'Task A Updated');
    assert.equal(r.todos[0].status, 'completed');
    assert.equal(r.todos[1].content, 'Task B');
    assert.equal(r.todos[1].status, 'in_progress');
  });

  it('TaskUpdate with invalid taskId is safely ignored', async () => {
    const f = join(SANDBOX, 'task-update-noop.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'Only task', status: 'pending' }] } }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'TaskUpdate', input: { taskId: '99', status: 'completed' } }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'TaskUpdate', input: { status: 'completed' } }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0].status, 'pending');
  });
});

describe('parseTranscript — session metadata', () => {
  it('extracts sessionStart from the first entry with timestamp', async () => {
    const f = join(SANDBOX, 'session-start.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read') +
      toolLine('2026-05-09T10:00:01Z', 't2', 'Bash')
    );
    const r = await parseTranscript(f);
    assert.ok(r.sessionStart instanceof Date);
    assert.equal(r.sessionStart.toISOString(), '2026-05-09T10:00:00.000Z');
  });

  it('sets sessionStart from first entry when timestamps are out of order', async () => {
    const f = join(SANDBOX, 'session-start-order.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T12:00:00Z', 't1', 'Read') +
      toolLine('2026-05-09T10:00:00Z', 't2', 'Bash')
    );
    const r = await parseTranscript(f);
    assert.equal(r.sessionStart.toISOString(), '2026-05-09T12:00:00.000Z');
  });

  it('extracts sessionName from custom-title type', async () => {
    const f = join(SANDBOX, 'session-name-title.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'custom-title', customTitle: 'My Custom Session Title' },
      { timestamp: '2026-05-09T10:00:01Z', slug: 'should-be-ignored' }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.sessionName, 'My Custom Session Title');
  });

  it('falls back to slug for sessionName', async () => {
    const f = join(SANDBOX, 'session-name-slug.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', slug: 'session-abc123' }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.sessionName, 'session-abc123');
  });

  it('prefers custom-title over slug', async () => {
    const f = join(SANDBOX, 'session-name-priority.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'custom-title', customTitle: 'Title wins' },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', slug: 'slug-loses' }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.sessionName, 'Title wins');
  });

  it('sets sessionName to undefined when absent', async () => {
    const f = join(SANDBOX, 'no-name.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    const r = await parseTranscript(f);
    assert.equal(r.sessionName, undefined);
  });
});

describe('parseTranscript — reversal counting', () => {
  it('counts reversals from assistant text blocks', async () => {
    const f = join(SANDBOX, 'reversals.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Wait, that is not right. Actually, I need to reconsider.' }] } }
    ));
    const r = await parseTranscript(f);
    assert.ok(r.reversalCount >= 2, `expected >= 2 reversals, got ${r.reversalCount}`);
  });

  it('does not count reversals from user messages', async () => {
    const f = join(SANDBOX, 'reversals-user.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Wait, actually I think you are wrong. Let me fix that.' }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.reversalCount, 0);
  });

  it('counts reversals across multiple entries', async () => {
    const f = join(SANDBOX, 'reversals-multi.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Wait, let me reconsider.' }] } },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sorry, my mistake.' }] } }
    ));
    const r = await parseTranscript(f);
    assert.ok(r.reversalCount >= 2, `expected >= 2 reversals, got ${r.reversalCount}`);
  });

  it('counts reversals alongside tool_use in same message', async () => {
    const f = join(SANDBOX, 'reversals-plus-tools.jsonl');
    writeFileSync(f, JSON.stringify({
      timestamp: '2026-05-09T10:00:00Z',
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Actually, let me fix that approach.' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.js' } },
        ],
      },
    }) + '\n');
    const r = await parseTranscript(f);
    assert.ok(r.reversalCount >= 1);
    assert.equal(r.toolCallCount, 1);
  });
});

describe('parseTranscript — cch hash mutation count', () => {
  it('counts lines containing cch=', async () => {
    const f = join(SANDBOX, 'cch.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read') +
      '{"timestamp":"2026-05-09T10:00:01Z","message":{"content":[{"type":"text","text":"cch=abc123"}]}}\n' +
      '{"timestamp":"2026-05-09T10:00:02Z","message":{"content":[{"type":"text","text":"cch=def456"}]}}\n'
    );
    const r = await parseTranscript(f);
    assert.equal(r.cchHashMutationCount, 2);
  });

  it('counts cch= on malformed JSON lines', async () => {
    const f = join(SANDBOX, 'cch-malformed.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read') +
      'garbage with cch=hash\n' +
      'more garbage no cch\n'
    );
    const r = await parseTranscript(f);
    assert.equal(r.cchHashMutationCount, 1);
    assert.equal(r.toolCallCount, 1);
  });

  it('does not count tool lines without cch=', async () => {
    const f = join(SANDBOX, 'cch-none.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    const r = await parseTranscript(f);
    assert.equal(r.cchHashMutationCount, 0);
  });
});

describe('parseTranscript — quota events', () => {
  it('extracts quota events from RESOURCE_EXHAUSTED lines', async () => {
    const f = join(SANDBOX, 'quota-resource.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RESOURCE_EXHAUSTED: quota exceeded for vertex-ai' }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.quotaEvents.length, 1);
    assert.equal(r.quotaEvents[0].code, 'RESOURCE_EXHAUSTED');
    assert.equal(r.quotaEvents[0].source, 'transcript');
    assert.equal(r.quotaEvents[0].backend, 'vertex-ai');
  });

  it('extracts quota events from HTTP 429 lines with quota language', async () => {
    const f = join(SANDBOX, 'quota-429.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'status: 429, quota limit reached' }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.quotaEvents.length, 1);
    assert.equal(r.quotaEvents[0].status, 429);
  });

  it('skips quota extraction on malformed JSON lines', async () => {
    const f = join(SANDBOX, 'quota-malformed.jsonl');
    writeFileSync(f,
      toolLine('2026-05-09T10:00:00Z', 't1', 'Read') +
      'RESOURCE_EXHAUSTED but not valid json\n'
    );
    const r = await parseTranscript(f);
    // quota extraction is inside the try block, so malformed lines don't produce quota events
    assert.equal(r.quotaEvents.length, 0);
  });

  it('does not create quota events from normal lines', async () => {
    const f = join(SANDBOX, 'quota-normal.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    const r = await parseTranscript(f);
    assert.equal(r.quotaEvents.length, 0);
  });

  it('preserves timestamp on quota events', async () => {
    const f = join(SANDBOX, 'quota-ts.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RESOURCE_EXHAUSTED' }] } }
    ));
    const r = await parseTranscript(f);
    assert.equal(r.quotaEvents.length, 1);
    assert.equal(r.quotaEvents[0].reason, undefined); // function doesn't add reason
    // verify the quota event has a timestamp
    assert.ok(r.quotaEvents[0].ts);
  });
});

describe('parseTranscript — caching', () => {
  it('caches parsed results on first parse', async () => {
    const f = join(SANDBOX, 'cache-first.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    const r1 = await parseTranscript(f);
    assert.equal(r1.toolCallCount, 1);
    // Verify cache creates a file in the cache dir
    const { readdirSync } = await import('node:fs');
    const cacheFiles = readdirSync(paths.TRANSCRIPT_CACHE_DIR);
    assert.ok(cacheFiles.length > 0);
  });

  it('returns cached data on subsequent calls to same file', async () => {
    const f = join(SANDBOX, 'cache-hit.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    const r1 = await parseTranscript(f);
    const r2 = await parseTranscript(f);
    assert.equal(r2.toolCallCount, r1.toolCallCount);
    assert.equal(r2.tools.length, r1.tools.length);
    assert.equal(r2.tools[0].id, r1.tools[0].id);
    assert.equal(r2.tools[0].name, r1.tools[0].name);
    assert.equal(String(r2.sessionStart), String(r1.sessionStart));
    assert.equal(r2.sessionName, r1.sessionName);
  });

  it('re-parses when file changes (cache miss)', async () => {
    const f = join(SANDBOX, 'cache-miss.jsonl');
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read'));
    await parseTranscript(f);
    // Modify file with different content
    await new Promise(r => setTimeout(r, 10));
    writeFileSync(f, toolLine('2026-05-09T10:00:00Z', 't1', 'Read') + toolLine('2026-05-09T10:00:01Z', 't2', 'Write'));
    const r2 = await parseTranscript(f);
    assert.equal(r2.toolCallCount, 2);
  });
});

describe('parseTranscript — integration', () => {
  it('returns complete structure with all fields populated', async () => {
    const f = join(SANDBOX, 'integration.jsonl');
    writeFileSync(f, jsonl(
      { timestamp: '2026-05-09T10:00:00Z', type: 'custom-title', customTitle: 'Integration Session' },
      { timestamp: '2026-05-09T10:00:01Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Let me start. Wait, actually...' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/index.js' } }] } },
      { timestamp: '2026-05-09T10:00:02Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'general', description: 'sub task' } }] } },
      { timestamp: '2026-05-09T10:00:03Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tw1', name: 'TodoWrite', input: { todos: [{ content: 'Fix bug', status: 'pending' }] } }] } },
      { timestamp: '2026-05-09T10:00:04Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      { timestamp: '2026-05-09T10:00:05Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'a1' }] } },
      { timestamp: '2026-05-09T10:00:06Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'cch=somehash' }] } },
      { timestamp: '2026-05-09T10:00:07Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RESOURCE_EXHAUSTED' }] } }
    ));
    const r = await parseTranscript(f);
    assertResultStructure(r);
    assert.ok(r.sessionStart instanceof Date);
    assert.equal(r.sessionName, 'Integration Session');
    assert.equal(r.toolCallCount, 3); // Read + Task + TodoWrite
    assert.equal(r.tools.length, 1); // only Read goes to toolMap
    assert.equal(r.tools[0].status, 'completed');
    assert.equal(r.agents.length, 1);
    assert.equal(r.agents[0].status, 'completed');
    assert.equal(r.todos.length, 1);
    assert.equal(r.todos[0].content, 'Fix bug');
    assert.ok(r.reversalCount >= 1);
    assert.equal(r.cchHashMutationCount, 1);
    assert.equal(r.quotaEvents.length, 1);
  });
});
