/**
 * Consolidate — Haiku bridge via the `claude` CLI.
 *
 * We avoid taking a direct dep on the Anthropic SDK. The user is
 * running claude-ops from a Claude Code session, so `claude` is
 * guaranteed on PATH. We shell out, feed the prompt on stdin, and
 * parse the response as JSON (claude --output-format json emits the
 * assistant's reply as `.result` or similar — we try a few shapes).
 *
 * Prompt templates live in prompts/*.md as plain text so the user
 * can tune them without editing JS.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = join(__dirname, 'prompts');

const HAIKU_MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 60_000;

/**
 * @returns {boolean} true when `claude` resolves on PATH
 */
export function claudeAvailable() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (r.error && r.error.code === 'ENOENT') return false;
  return r.status === 0 || (r.stdout ?? '').length > 0;
}

/**
 * Load a prompt template by name (no extension).
 *
 * @param {string} name
 * @returns {string}
 */
export function loadPrompt(name) {
  return readFileSync(join(PROMPT_DIR, `${name}.md`), 'utf8');
}

/**
 * Run Haiku with a full prompt string. Returns the raw assistant text
 * or null on error (with `err` populated).
 *
 * @param {string} prompt
 * @returns {{ text: string|null, err: string|null }}
 */
export function invokeHaiku(prompt) {
  const r = spawnSync(
    'claude',
    ['--model', HAIKU_MODEL, '--print', '--output-format', 'json'],
    { input: prompt, encoding: 'utf8', timeout: TIMEOUT_MS },
  );
  if (r.error) return { text: null, err: r.error.message };
  if (r.status !== 0) return { text: null, err: (r.stderr ?? '').trim().slice(0, 200) };
  const text = extractAssistantText(r.stdout);
  if (text === null) return { text: null, err: 'haiku-response-shape-unrecognized' };
  return { text, err: null };
}

/**
 * "Quick and dirty fix-up" for the many shapes `claude --output-format
 * json` has shipped across versions. In order:
 *   1. Parse stdout as JSON, walk known envelope keys
 *      (result, content, message, response, text).
 *   2. If content is an array of `{type,text}` blocks (Claude native),
 *      concatenate every `.text` field.
 *   3. Walk one level deeper into any object-valued envelope key.
 *   4. Fall back to the raw stdout — newer claude CLIs sometimes print
 *      plain assistant text even with --output-format json when the
 *      model returns a non-JSON body.
 *
 * Returns the assistant-text string or null.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
export function extractAssistantText(stdout) {
  if (!stdout) return null;
  const raw = stdout.trim();

  const walk = (v, depth = 0) => {
    if (depth > 3) return null;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      // Claude's content-block array.
      const parts = v.map(x => x?.text ?? (typeof x === 'string' ? x : '')).filter(Boolean);
      if (parts.length) return parts.join('\n');
      return null;
    }
    if (v && typeof v === 'object') {
      for (const k of ['result', 'content', 'message', 'response', 'text', 'body', 'output']) {
        if (k in v) {
          const hit = walk(v[k], depth + 1);
          if (typeof hit === 'string' && hit.length) return hit;
        }
      }
    }
    return null;
  };

  try {
    const parsed = JSON.parse(raw);
    const found = walk(parsed);
    if (found) return found;
  } catch { /* not JSON */ }

  // Fallback: treat stdout as assistant text when it's not JSON or
  // when no envelope key produced content. Strip any leading "```"
  // fences so downstream JSON extraction has a clean slate.
  return raw;
}

/**
 * Extract the first / best JSON object from assistant text. Quick and
 * dirty fix-up mode: try a fenced ```json block first, then any fenced
 * ``` block, then the first balanced `{...}` substring, then the raw
 * text. Returns null only when every path fails.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;

  const tryParse = (s) => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  // 1. ```json ... ```
  let m = text.match(/```json\s*([\s\S]*?)```/i);
  if (m) { const p = tryParse(m[1].trim()); if (p) return p; }

  // 2. ``` ... ``` (any fence)
  m = text.match(/```[a-z]*\s*([\s\S]*?)```/i);
  if (m) { const p = tryParse(m[1].trim()); if (p) return p; }

  // 3. First balanced {...} — greedy scan. Handles assistant text that
  // wraps the JSON in prose without fences.
  const braceStart = text.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = braceStart; i < text.length; i++) {
      const c = text[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const p = tryParse(text.slice(braceStart, i + 1));
          if (p) return p;
          break;
        }
      }
    }
  }

  // 4. Raw text as JSON.
  return tryParse(text.trim());
}

/**
 * Merge N overlapping artifacts into one proposed canonical.
 *
 * @param {Array<{path: string, body: string}>} members - canonical first
 * @returns {{ ok: boolean, proposal: object|null, raw: string|null, err: string|null }}
 */
export function mergeDuplicates(members) {
  if (!claudeAvailable()) return { ok: false, proposal: null, raw: null, err: 'claude-cli-missing' };
  const template = loadPrompt('merge-duplicates');
  const inputs = members.map(m => `=== INPUT ${m.path} ===\n${m.body}`).join('\n\n');
  const { text, err } = invokeHaiku(`${template}\n\n${inputs}`);
  if (err) return { ok: false, proposal: null, raw: text, err };
  const proposal = extractJson(text);
  if (!proposal || !proposal.body) return { ok: false, proposal: null, raw: text, err: 'parse-failed' };
  return { ok: true, proposal, raw: text, err: null };
}

/**
 * Decide whether a memory file should be promoted.
 *
 * @param {{path: string, body: string}} memory
 * @returns {{ ok: boolean, proposal: object|null, raw: string|null, err: string|null }}
 */
export function promoteMemory(memory) {
  if (!claudeAvailable()) return { ok: false, proposal: null, raw: null, err: 'claude-cli-missing' };
  const template = loadPrompt('promote-memory');
  const { text, err } = invokeHaiku(`${template}\n\n=== MEMORY ${memory.path} ===\n${memory.body}`);
  if (err) return { ok: false, proposal: null, raw: text, err };
  const proposal = extractJson(text);
  if (!proposal || !proposal.promote_to) return { ok: false, proposal: null, raw: text, err: 'parse-failed' };
  return { ok: true, proposal, raw: text, err: null };
}
