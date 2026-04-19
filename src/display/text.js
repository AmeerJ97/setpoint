/**
 * ANSI-aware grapheme text engine.
 * Ported from claude-hud's render/index.ts — handles grapheme segmentation,
 * East Asian wide characters, emoji ZWJ sequences, and ANSI escape codes.
 */

import { RESET } from './colors.js';

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /^\x1b\[[0-9;]*m/;
const ANSI_ESCAPE_GLOBAL = /\x1b\[[0-9;]*m/g;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * Strip all ANSI escape sequences from a string.
 * @param {string} str
 * @returns {string}
 */
export function stripAnsi(str) {
  return str.replace(ANSI_ESCAPE_GLOBAL, '');
}

/**
 * Split a string into alternating ANSI escape and text tokens.
 * @param {string} str
 * @returns {Array<{ type: 'ansi'|'text', value: string }>}
 */
function splitAnsiTokens(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const ansiMatch = ANSI_ESCAPE_PATTERN.exec(str.slice(i));
    if (ansiMatch) {
      tokens.push({ type: 'ansi', value: ansiMatch[0] });
      i += ansiMatch[0].length;
      continue;
    }
    let j = i;
    while (j < str.length) {
      if (ANSI_ESCAPE_PATTERN.test(str.slice(j))) break;
      j += 1;
    }
    tokens.push({ type: 'text', value: str.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * Segment text into grapheme clusters.
 * @param {string} text
 * @returns {string[]}
 */
function segmentGraphemes(text) {
  if (!text) return [];
  if (!GRAPHEME_SEGMENTER) return Array.from(text);
  return Array.from(GRAPHEME_SEGMENTER.segment(text), s => s.segment);
}

/**
 * Check if a code point is East Asian wide.
 * @param {number} codePoint
 * @returns {boolean}
 */
function isWideCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115F ||
    codePoint === 0x2329 ||
    codePoint === 0x232A ||
    (codePoint >= 0x2E80 && codePoint <= 0xA4CF && codePoint !== 0x303F) ||
    (codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
    (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
    (codePoint >= 0xFE10 && codePoint <= 0xFE19) ||
    (codePoint >= 0xFE30 && codePoint <= 0xFE6F) ||
    (codePoint >= 0xFF00 && codePoint <= 0xFF60) ||
    (codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||
    (codePoint >= 0x1F300 && codePoint <= 0x1FAFF) ||
    (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
  );
}

/**
 * Calculate the visual width of a single grapheme cluster.
 * @param {string} grapheme
 * @returns {number}
 */
function graphemeWidth(grapheme) {
  if (!grapheme || /^\p{Control}$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;

  let hasVisibleBase = false;
  let width = 0;
  for (const char of Array.from(grapheme)) {
    if (/^\p{Mark}$/u.test(char) || char === '\u200D' || char === '\uFE0F') continue;
    hasVisibleBase = true;
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && isWideCodePoint(codePoint)) {
      width = Math.max(width, 2);
    } else {
      width = Math.max(width, 1);
    }
  }
  return hasVisibleBase ? width : 0;
}

/**
 * Calculate the visual width of a string, skipping ANSI escapes.
 * @param {string} str
 * @returns {number}
 */
export function visualLength(str) {
  let width = 0;
  for (const token of splitAnsiTokens(str)) {
    if (token.type === 'ansi') continue;
    for (const grapheme of segmentGraphemes(token.value)) {
      width += graphemeWidth(grapheme);
    }
  }
  return width;
}

/**
 * Slice a string to at most maxVisible visual columns, preserving ANSI escapes.
 * @param {string} str
 * @param {number} maxVisible
 * @returns {string}
 */
export function sliceVisible(str, maxVisible) {
  if (maxVisible <= 0) return '';

  let result = '';
  let visibleWidth = 0;
  let done = false;
  let i = 0;

  while (i < str.length && !done) {
    const ansiMatch = ANSI_ESCAPE_PATTERN.exec(str.slice(i));
    if (ansiMatch) {
      result += ansiMatch[0];
      i += ansiMatch[0].length;
      continue;
    }

    let j = i;
    while (j < str.length) {
      if (ANSI_ESCAPE_PATTERN.test(str.slice(j))) break;
      j += 1;
    }

    const plainChunk = str.slice(i, j);
    for (const grapheme of segmentGraphemes(plainChunk)) {
      const gw = graphemeWidth(grapheme);
      if (visibleWidth + gw > maxVisible) {
        done = true;
        break;
      }
      result += grapheme;
      visibleWidth += gw;
    }

    i = j;
  }

  return result;
}

/**
 * Truncate a string to maxWidth visual columns, appending '...' if needed.
 * @param {string} str
 * @param {number} maxWidth
 * @returns {string}
 */
export function truncateToWidth(str, maxWidth) {
  if (maxWidth <= 0 || visualLength(str) <= maxWidth) return str;

  const suffix = maxWidth >= 3 ? '...' : '.'.repeat(maxWidth);
  const keep = Math.max(0, maxWidth - suffix.length);
  return `${sliceVisible(str, keep)}${suffix}${RESET}`;
}

/**
 * Wrap a line at separator boundaries ( | or │ ) to fit within maxWidth.
 * Keeps [model | provider] badges atomic.
 * @param {string} line
 * @param {number} maxWidth
 * @returns {string[]}
 */
export function wrapLineToWidth(line, maxWidth) {
  if (maxWidth <= 0 || visualLength(line) <= maxWidth) return [line];

  const parts = splitWrapParts(line);
  if (parts.length <= 1) return [truncateToWidth(line, maxWidth)];

  const wrapped = [];
  let current = parts[0].segment;

  for (const part of parts.slice(1)) {
    const candidate = `${current}${part.separator}${part.segment}`;
    if (visualLength(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    wrapped.push(truncateToWidth(current, maxWidth));
    current = part.segment;
  }

  if (current) wrapped.push(truncateToWidth(current, maxWidth));
  return wrapped;
}

function splitLineBySeparators(line) {
  const segments = [];
  const separators = [];
  let currentStart = 0;
  let i = 0;

  while (i < line.length) {
    const ansiMatch = ANSI_ESCAPE_PATTERN.exec(line.slice(i));
    if (ansiMatch) {
      i += ansiMatch[0].length;
      continue;
    }
    const separator = line.startsWith(' | ', i)
      ? ' | '
      : (line.startsWith(' │ ', i) ? ' │ ' : null);
    if (separator) {
      segments.push(line.slice(currentStart, i));
      separators.push(separator);
      i += separator.length;
      currentStart = i;
      continue;
    }
    i += 1;
  }
  segments.push(line.slice(currentStart));
  return { segments, separators };
}

function splitWrapParts(line) {
  const { segments, separators } = splitLineBySeparators(line);
  if (segments.length === 0) return [];

  let parts = [{ separator: '', segment: segments[0] }];
  for (let idx = 1; idx < segments.length; idx++) {
    parts.push({ separator: separators[idx - 1] ?? ' | ', segment: segments[idx] });
  }

  // Keep [model | provider] block atomic
  const firstVisible = stripAnsi(parts[0].segment).trimStart();
  const firstHasOpen = firstVisible.startsWith('[');
  const firstHasClose = stripAnsi(parts[0].segment).includes(']');
  if (firstHasOpen && !firstHasClose && parts.length > 1) {
    let merged = parts[0].segment;
    let consumeIndex = 1;
    while (consumeIndex < parts.length) {
      const next = parts[consumeIndex];
      merged += `${next.separator}${next.segment}`;
      consumeIndex += 1;
      if (stripAnsi(next.segment).includes(']')) break;
    }
    parts = [{ separator: '', segment: merged }, ...parts.slice(consumeIndex)];
  }

  return parts;
}
