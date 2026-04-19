/**
 * Transcript parser — extracts tools, agents, todos from session JSONL.
 * Ported from old HUD transcript.ts with content-hash cache.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { TRANSCRIPT_CACHE_DIR } from '../data/paths.js';

/**
 * @typedef {object} TranscriptData
 * @property {Array<{id:string, name:string, target?:string, status:string, startTime:Date, endTime?:Date}>} tools
 * @property {Array<{id:string, type:string, model?:string, description?:string, status:string, startTime:Date, endTime?:Date}>} agents
 * @property {Array<{content:string, status:string}>} todos
 * @property {Date} [sessionStart]
 * @property {string} [sessionName]
 */

/**
 * @param {string} transcriptPath
 * @returns {string}
 */
function getCachePath(transcriptPath) {
  const hash = createHash('sha256').update(resolve(transcriptPath)).digest('hex');
  return join(TRANSCRIPT_CACHE_DIR, `${hash}.json`);
}

/**
 * @param {string} transcriptPath
 * @returns {Promise<TranscriptData>}
 */
export async function parseTranscript(transcriptPath) {
  const empty = { tools: [], agents: [], todos: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) return empty;

  let stat;
  try { stat = statSync(transcriptPath); } catch { return empty; }
  if (!stat.isFile()) return empty;

  // Check cache
  try {
    const cachePath = getCachePath(transcriptPath);
    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return deserialize(cached.data);
      }
    }
  } catch { /* cache miss */ }

  // Parse fresh
  const toolMap = new Map();
  const agentMap = new Map();
  let latestTodos = [];
  const taskIdToIndex = new Map();
  let sessionStart;
  let sessionName;
  let parsedCleanly = false;

  try {
    const rl = createInterface({
      input: createReadStream(transcriptPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
        if (!sessionStart && entry.timestamp) sessionStart = ts;

        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
          sessionName = entry.customTitle;
        } else if (typeof entry.slug === 'string') {
          sessionName = sessionName ?? entry.slug;
        }

        processEntry(entry, ts, toolMap, agentMap, taskIdToIndex, latestTodos);
      } catch { /* skip malformed */ }
    }
    parsedCleanly = true;
  } catch { /* partial results */ }

  const result = {
    tools: Array.from(toolMap.values()).slice(-20),
    agents: Array.from(agentMap.values()).slice(-10),
    todos: latestTodos,
    sessionStart,
    sessionName,
  };

  if (parsedCleanly) {
    try {
      mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });
      writeFileSync(getCachePath(transcriptPath), JSON.stringify({
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        data: serialize(result),
      }));
    } catch { /* cache write failure non-fatal */ }
  }

  return result;
}

function processEntry(entry, ts, toolMap, agentMap, taskIdToIndex, latestTodos) {
  const content = entry.message?.content;
  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use' && block.id && block.name) {
      if (block.name === 'Task' || block.name === 'Agent') {
        const input = block.input ?? {};
        agentMap.set(block.id, {
          id: block.id,
          type: input.subagent_type ?? 'unknown',
          model: input.model,
          description: input.description,
          status: 'running',
          startTime: ts,
        });
      } else if (block.name === 'TodoWrite') {
        const input = block.input ?? {};
        if (Array.isArray(input.todos)) {
          latestTodos.length = 0;
          taskIdToIndex.clear();
          latestTodos.push(...input.todos);
        }
      } else if (block.name === 'TaskCreate') {
        const input = block.input ?? {};
        const taskContent = input.subject || input.description || 'Untitled task';
        const status = normalizeStatus(input.status) ?? 'pending';
        latestTodos.push({ content: taskContent, status });
        const taskId = String(input.taskId ?? block.id);
        taskIdToIndex.set(taskId, latestTodos.length - 1);
      } else if (block.name === 'TaskUpdate') {
        const input = block.input ?? {};
        const idx = resolveTaskIndex(input.taskId, taskIdToIndex, latestTodos);
        if (idx !== null) {
          const status = normalizeStatus(input.status);
          if (status) latestTodos[idx].status = status;
          const c = input.subject || input.description;
          if (c) latestTodos[idx].content = c;
        }
      } else {
        toolMap.set(block.id, {
          id: block.id,
          name: block.name,
          target: extractTarget(block.name, block.input),
          status: 'running',
          startTime: ts,
        });
      }
    }

    if (block.type === 'tool_result' && block.tool_use_id) {
      const tool = toolMap.get(block.tool_use_id);
      if (tool) { tool.status = block.is_error ? 'error' : 'completed'; tool.endTime = ts; }
      const agent = agentMap.get(block.tool_use_id);
      if (agent) { agent.status = 'completed'; agent.endTime = ts; }
    }
  }
}

function extractTarget(name, input) {
  if (!input) return undefined;
  if (name === 'Read' || name === 'Write' || name === 'Edit') return input.file_path ?? input.path;
  if (name === 'Glob' || name === 'Grep') return input.pattern;
  if (name === 'Bash') { const cmd = input.command; return cmd?.slice(0, 30) + (cmd?.length > 30 ? '...' : ''); }
  return undefined;
}

function resolveTaskIndex(taskId, taskIdToIndex, latestTodos) {
  if (taskId == null) return null;
  const key = String(taskId);
  const mapped = taskIdToIndex.get(key);
  if (typeof mapped === 'number') return mapped;
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10) - 1;
    if (idx >= 0 && idx < latestTodos.length) return idx;
  }
  return null;
}

function normalizeStatus(status) {
  if (typeof status !== 'string') return null;
  if (status === 'pending' || status === 'not_started') return 'pending';
  if (status === 'in_progress' || status === 'running') return 'in_progress';
  if (status === 'completed' || status === 'complete' || status === 'done') return 'completed';
  return null;
}

function serialize(data) {
  return {
    tools: data.tools.map(t => ({ ...t, startTime: t.startTime.toISOString(), endTime: t.endTime?.toISOString() })),
    agents: data.agents.map(a => ({ ...a, startTime: a.startTime.toISOString(), endTime: a.endTime?.toISOString() })),
    todos: data.todos.map(t => ({ ...t })),
    sessionStart: data.sessionStart?.toISOString(),
    sessionName: data.sessionName,
  };
}

function deserialize(data) {
  return {
    tools: data.tools.map(t => ({ ...t, startTime: new Date(t.startTime), endTime: t.endTime ? new Date(t.endTime) : undefined })),
    agents: data.agents.map(a => ({ ...a, startTime: new Date(a.startTime), endTime: a.endTime ? new Date(a.endTime) : undefined })),
    todos: data.todos.map(t => ({ ...t })),
    sessionStart: data.sessionStart ? new Date(data.sessionStart) : undefined,
    sessionName: data.sessionName,
  };
}
