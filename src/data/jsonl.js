import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

/**
 * Append a single JSON object as a line to a JSONL file.
 * Uses O_APPEND for atomicity on writes < PIPE_BUF (4096 bytes).
 * @param {string} filePath
 * @param {object} entry
 */
export function appendJsonl(filePath, entry) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/**
 * Read all lines from a JSONL file, parsing each as JSON.
 * Skips malformed lines silently.
 * @param {string} filePath
 * @returns {object[]}
 */
export function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    const results = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        results.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Read JSONL entries within a rolling time window.
 * @param {string} filePath
 * @param {number} windowMs - window size in milliseconds
 * @param {string} [tsField='ts'] - field name containing ISO timestamp
 * @returns {object[]}
 */
export function readJsonlWindow(filePath, windowMs, tsField = 'ts') {
  const cutoff = Date.now() - windowMs;
  const all = readJsonl(filePath);
  return all.filter(entry => {
    const ts = entry[tsField];
    if (!ts) return false;
    return new Date(ts).getTime() >= cutoff;
  });
}

/**
 * Write a JSON file atomically (write to temp, then rename).
 * Safe for concurrent readers.
 * @param {string} filePath
 * @param {object} data
 */
export function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpFile = join(dirname(filePath), `.tmp-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  renameSync(tmpFile, filePath);
}

/**
 * Rotate a JSONL file if it exceeds maxBytes.
 * Keeps the last keepLines entries, writes atomically.
 * @param {string} filePath
 * @param {number} maxBytes - rotate when file exceeds this size
 * @param {number} keepLines - number of recent entries to retain
 * @returns {boolean} true if rotation occurred
 */
export function rotateJsonl(filePath, maxBytes, keepLines) {
  try {
    if (!existsSync(filePath)) return false;
    const stat = statSync(filePath);
    if (stat.size <= maxBytes) return false;

    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const kept = lines.slice(-keepLines);
    const tmpFile = join(dirname(filePath), `.tmp-${randomBytes(6).toString('hex')}.jsonl`);
    writeFileSync(tmpFile, kept.join('\n') + '\n');
    renameSync(tmpFile, filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON file, returning null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
export function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
