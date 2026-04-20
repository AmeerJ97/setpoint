/**
 * Token bucketing for the `setpoint context` CLI.
 *
 * Native /context (Claude Code 2.1.111+) renders an authoritative bucket
 * grid that we cannot read programmatically — no flag, no JSON dump, only
 * an interactive TUI. We replicate the breakdown by:
 *
 *   1. Reading the *true* total from the latest assistant turn's
 *      `usage.input_tokens` in the session JSONL. That number is what
 *      Claude actually billed and saw.
 *   2. Estimating each non-Messages bucket from its on-disk source
 *      (file size / ~3.5 chars-per-token for Claude's BPE).
 *   3. Letting Messages absorb whatever total remains (with a floor of 0
 *      so an over-estimated bucket doesn't underflow the display).
 *
 * The native /context still wins on accuracy because it has access to
 * Claude Code's internal tool-token tables; we're explicit about that in
 * the CLI's --help output and in the rendered footer.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { CLAUDE_DIR } from '../data/paths.js';

const CHARS_PER_TOKEN = 3.5;

/**
 * Built-in tool baseline. The native /context groups these as "System
 * Tools" — Read, Write, Edit, Bash, Glob, Grep, Task, etc. The numbers
 * change with each Claude Code release as tool descriptions get edited;
 * 12K is a calibrated estimate for v2.1.114 (measured against a fresh
 * session's `/context` output ± a few hundred tokens). Refreshed by hand
 * when the gap exceeds ±5%.
 */
const SYSTEM_TOOLS_BASELINE_TOKENS = 12_000;

/**
 * The static Claude Code system prompt header. Same caveat as
 * SYSTEM_TOOLS_BASELINE_TOKENS — calibrated, not derived.
 */
const SYSTEM_PROMPT_BASELINE_TOKENS = 3_000;

/**
 * Autocompact buffer reservation. Claude Code holds back ~16.5% of the
 * window for the post-compaction summary so the next turn doesn't OOM
 * the context. Visible in stdin's `used_percentage` vs raw token math.
 */
const AUTOCOMPACT_BUFFER_FRACTION = 0.165;

/**
 * @typedef {object} Bucket
 * @property {string} name
 * @property {number} tokens
 * @property {string} source         Short label describing where the count came from.
 */

/**
 * @typedef {object} BucketReport
 * @property {Bucket[]} buckets
 * @property {number} totalTokens          sum of non-Free, non-Buffer buckets
 * @property {number} contextWindow        window size from stdin / JSONL
 * @property {number} freeSpace
 * @property {number} autocompactBuffer
 * @property {string} modelLabel
 * @property {string} [transcriptPath]
 * @property {boolean} approximate         always true — kept as a flag the renderer can surface
 */

/**
 * Estimate token count from a UTF-8 string. Claude's BPE is closer to
 * 3.5 chars/token than the often-quoted 4 (verified against tiktoken
 * compat layers); over-estimating Messages by 15% would push other
 * buckets negative which the renderer can't recover from gracefully.
 * @param {string} s
 * @returns {number}
 */
export function estimateTokens(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  return Math.round(s.length / CHARS_PER_TOKEN);
}

/**
 * Walk a directory for files matching `predicate(name)`, sum their UTF-8
 * size in chars. Recurses one level (matches /agents and /skills layout
 * — neither nests deeper in practice).
 * @param {string} dir
 * @param {(name: string) => boolean} predicate
 * @returns {number}
 */
export function sumDirChars(dir, predicate) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return 0; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      // One level deep — skills/<name>/SKILL.md is the canonical layout.
      let inner;
      try { inner = readdirSync(p, { withFileTypes: true }); }
      catch { continue; }
      for (const ie of inner) {
        if (ie.isFile() && predicate(ie.name)) {
          try { total += readFileSync(join(p, ie.name), 'utf8').length; }
          catch { /* unreadable — skip */ }
        }
      }
    } else if (e.isFile() && predicate(e.name)) {
      try { total += readFileSync(p, 'utf8').length; }
      catch { /* unreadable — skip */ }
    }
  }
  return total;
}

/**
 * Estimate the Custom Agents bucket. Walks user-scope and project-scope
 * agents directories.
 * @param {string} cwd
 * @returns {number}
 */
export function estimateAgentsTokens(cwd = process.cwd()) {
  const userChars = sumDirChars(join(CLAUDE_DIR, 'agents'), n => n.endsWith('.md'));
  const projectChars = sumDirChars(join(cwd, '.claude', 'agents'), n => n.endsWith('.md'));
  return estimateTokens(' '.repeat(userChars + projectChars));
}

/**
 * Estimate the Skills bucket. Skills follow `~/.claude/skills/<name>/SKILL.md`
 * (or skill.md). User-scope only — there's no per-project skills convention
 * we'd respect.
 * @returns {number}
 */
export function estimateSkillsTokens() {
  const skillsDir = join(CLAUDE_DIR, 'skills');
  const chars = sumDirChars(skillsDir, n => /^skill\.md$/i.test(n));
  return estimateTokens(' '.repeat(chars));
}

/**
 * Walk the CLAUDE.md chain — user-global + project + any walked-up parents.
 * @param {string} cwd
 * @returns {number}
 */
export function estimateMemoryTokens(cwd = process.cwd()) {
  let chars = 0;
  const userMd = join(CLAUDE_DIR, 'CLAUDE.md');
  if (existsSync(userMd)) {
    try { chars += readFileSync(userMd, 'utf8').length; } catch { /* skip */ }
  }
  // Walk from cwd up to home, picking up CLAUDE.md at each level (matches
  // Claude Code's resolution order documented in the global CLAUDE.md).
  let dir = cwd;
  const home = homedir();
  // Cap at 12 levels to defend against pathological symlink loops.
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'CLAUDE.md');
    if (existsSync(candidate) && candidate !== userMd) {
      try { chars += readFileSync(candidate, 'utf8').length; } catch { /* skip */ }
    }
    if (dir === home || dir === '/' || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  return estimateTokens(' '.repeat(chars));
}

/**
 * Estimate MCP tool surface from `~/.claude/plugins/cache/`. Each MCP
 * server cache is a JSON blob containing tool defs; we sum its bytes
 * and convert. Falls back to 0 silently if no cache is present.
 * @returns {number}
 */
export function estimateMcpTokens() {
  const cacheDir = join(CLAUDE_DIR, 'plugins', 'cache');
  if (!existsSync(cacheDir)) return 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      try { bytes += statSync(join(cacheDir, entry.name)).size; }
      catch { /* skip */ }
    }
  } catch { /* skip */ }
  return Math.round(bytes / CHARS_PER_TOKEN);
}

/**
 * Read the LATEST assistant turn's input_tokens — that is the
 * authoritative "what Claude saw at the last billed turn" number.
 * @param {string} jsonlPath
 * @returns {number|null}
 */
export function readLatestInputTokens(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;
  let raw;
  try { raw = readFileSync(jsonlPath, 'utf8'); }
  catch { return null; }
  // Walk lines from the bottom — the first assistant message we hit wins.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.message?.role === 'assistant' && entry?.message?.usage) {
      const u = entry.message.usage;
      return (u.input_tokens ?? 0)
           + (u.cache_creation_input_tokens ?? 0)
           + (u.cache_read_input_tokens ?? 0);
    }
  }
  return null;
}

/**
 * Build the bucket report. Pure-ish — takes overrides for testability.
 *
 * @param {object} opts
 * @param {string} [opts.transcriptPath]
 * @param {number} [opts.contextWindow]    falls back to 200_000
 * @param {string} [opts.modelLabel]
 * @param {string} [opts.cwd]
 * @returns {BucketReport}
 */
export function buildBucketReport(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const contextWindow = Number.isFinite(opts.contextWindow) && opts.contextWindow > 0
    ? opts.contextWindow
    : 200_000;
  const modelLabel = opts.modelLabel ?? 'unknown';
  const transcriptPath = opts.transcriptPath;

  const buckets = [];

  buckets.push({
    name: 'System Prompt',
    tokens: SYSTEM_PROMPT_BASELINE_TOKENS,
    source: 'baseline (calibrated)',
  });
  buckets.push({
    name: 'System Tools',
    tokens: SYSTEM_TOOLS_BASELINE_TOKENS,
    source: 'baseline (calibrated)',
  });

  const mcpTokens = estimateMcpTokens();
  buckets.push({
    name: 'MCP Tools',
    tokens: mcpTokens,
    source: '~/.claude/plugins/cache/',
  });

  const agentsTokens = estimateAgentsTokens(cwd);
  buckets.push({
    name: 'Custom Agents',
    tokens: agentsTokens,
    source: 'agents/*.md',
  });

  const memoryTokens = estimateMemoryTokens(cwd);
  buckets.push({
    name: 'Memory Files',
    tokens: memoryTokens,
    source: 'CLAUDE.md walk',
  });

  const skillsTokens = estimateSkillsTokens();
  buckets.push({
    name: 'Skills',
    tokens: skillsTokens,
    source: 'skills/*/SKILL.md',
  });

  // Messages — pull the truth-source total, subtract the buckets we know.
  let messagesTokens = 0;
  let messagesSource = 'no transcript';
  if (transcriptPath) {
    const total = readLatestInputTokens(transcriptPath);
    if (total !== null) {
      const otherSum = buckets.reduce((acc, b) => acc + b.tokens, 0);
      messagesTokens = Math.max(0, total - otherSum);
      messagesSource = 'jsonl: input_tokens − (other buckets)';
    }
  }
  buckets.push({
    name: 'Messages',
    tokens: messagesTokens,
    source: messagesSource,
  });

  const totalTokens = buckets.reduce((acc, b) => acc + b.tokens, 0);
  const autocompactBuffer = Math.round(contextWindow * AUTOCOMPACT_BUFFER_FRACTION);
  const freeSpace = Math.max(0, contextWindow - totalTokens - autocompactBuffer);

  return {
    buckets,
    totalTokens,
    contextWindow,
    freeSpace,
    autocompactBuffer,
    modelLabel,
    transcriptPath,
    approximate: true,
  };
}
