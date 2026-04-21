/**
 * Shared formatting utilities for HUD lines.
 */
import { visualLength } from './text.js';

/**
 * Pad a label to a consistent width for vertical column alignment.
 * Full: 7 chars (longest labels are "Context", "Advisor").
 * Narrow: 3 chars (all abbreviations are 3 chars).
 * @param {string} label
 * @param {boolean} [narrow=false]
 * @returns {string}
 */
export function padLabel(label, narrow = false) {
  return narrow ? label.padEnd(3) : label.padEnd(7);
}

/**
 * Pad an already-colored string to a fixed visual width by appending
 * spaces. Needed for column alignment because the stock `padEnd`
 * counts ANSI escape bytes and over-pads colored strings.
 * @param {string} str
 * @param {number} width
 * @returns {string}
 */
export function padVisualEnd(str, width) {
  const w = visualLength(str);
  if (w >= width) return str;
  return str + ' '.repeat(width - w);
}

/**
 * Format a token count as human-readable.
 * @param {number} n
 * @returns {string}
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/**
 * Format a duration from start date to now.
 * @param {Date|undefined} sessionStart
 * @param {function} [now=Date.now]
 * @returns {string}
 */
export function formatDuration(sessionStart, now = Date.now) {
  if (!sessionStart) return '';
  const ms = now() - sessionStart.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h${rem > 0 ? ` ${rem}m` : ''}`;
}

/**
 * Format a reset time as relative duration.
 * @param {Date|null} resetAt
 * @returns {string}
 */
export function formatResetTime(resetAt) {
  if (!resetAt) return '';
  const diffMs = resetAt.getTime() - Date.now();
  if (diffMs <= 0) return '';
  const diffMins = Math.ceil(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remH = hours % 24;
    return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
