/**
 * Shared constants for anomaly detection.
 * Centralizes thresholds and helper functions.
 */

import { THRESHOLDS } from './thresholds.js';

// Read:Edit ratio thresholds
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LSP']);
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export const RE_RATIO_HEALTHY = THRESHOLDS.RE_RATIO_HEALTHY;  // >= this is good
export const RE_RATIO_WARN = THRESHOLDS.RE_RATIO_WARN;        // < this triggers warning
export const RE_RATIO_CRITICAL = THRESHOLDS.RE_RATIO_CRITICAL;// < this triggers critical (Opus only)
export const RE_MIN_EDITS = THRESHOLDS.RE_MIN_EDITS;          // don't alert until this many edits

// Token spike thresholds
export const TOKEN_SPIKE_THRESHOLD = THRESHOLDS.TOKEN_SPIKE;

// Agent spawn thresholds
export const MAX_SPAWNS_PER_HOUR = THRESHOLDS.MAX_SPAWNS_PER_HOUR;

// Context thrashing thresholds
export const MAX_COMPACTIONS_PER_SESSION = THRESHOLDS.MAX_COMPACTIONS;

// Stale session thresholds
export const MAX_HOURS_WITHOUT_COMPACTION = THRESHOLDS.MAX_HOURS_WITHOUT_COMPACTION;

// GrowthBook escalation thresholds (two-tier)
export const GUARD_ACTIVATIONS_WARN = THRESHOLDS.GUARD_ACTIVATIONS_WARN;
export const GUARD_ACTIVATIONS_CRITICAL = THRESHOLDS.GUARD_ACTIVATIONS_CRITICAL;

// MCP failure thresholds
export const MCP_FAILURE_STREAK_THRESHOLD = THRESHOLDS.MCP_FAILURE_STREAK;

/**
 * Calculate read and edit counts from tool counts.
 * @param {Record<string, number>} toolCounts
 * @returns {{ reads: number, edits: number }}
 */
export function countReadEdits(toolCounts) {
  let reads = 0;
  let edits = 0;

  for (const [tool, count] of Object.entries(toolCounts)) {
    if (READ_TOOLS.has(tool)) reads += count;
    if (WRITE_TOOLS.has(tool)) edits += count;
  }

  return { reads, edits };
}

/**
 * Calculate read:edit ratio.
 * @param {number} reads
 * @param {number} edits
 * @returns {number}
 */
export function calculateRatio(reads, edits) {
  if (edits === 0) return reads > 0 ? Infinity : 0;
  return reads / edits;
}

/**
 * Check if model name indicates Opus.
 * @param {string} [modelName]
 * @returns {boolean}
 */
export function isOpus(modelName) {
  if (!modelName) return false;
  return modelName.toLowerCase().includes('opus');
}
