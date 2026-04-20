/**
 * Display renderer — orchestrates 8-line HUD output.
 * Single-column layout. All lines always visible. Active = white,
 * inactive = dim gray.
 */

import { RESET } from './colors.js';
import { getTerminalWidth, isNarrowTerminal } from './terminal.js';
import { wrapLineToWidth } from './text.js';
import { sanitizeForPlain } from './glyphs.js';
import {
  renderModelLine,
  renderContextLine,
  renderUsageLine,
  renderTokensLine,
  renderMcpsLine,
  renderEnvLine,
  renderGuardLine,
  renderAdvisorLine,
} from './lines/index.js';

/**
 * @typedef {object} RenderContext
 * @property {import('../data/stdin.js').StdinData} stdin
 * @property {import('../data/stdin.js').UsageData|null} usageData
 * @property {{ branch: string, isDirty: boolean, ahead: number, behind: number }|null} gitStatus
 * @property {string} sessionDuration
 * @property {number} claudeMdCount
 * @property {number} rulesCount
 * @property {number} mcpCount
 * @property {number} hooksCount
 * @property {string[]} activeMcps
 * @property {string} effort
 * @property {boolean} isCompressed
 * @property {{ totalInput?: number, totalOutput?: number, totalCacheCreate?: number, totalCacheRead?: number, burnRate?: number, apiCalls?: number, thinkingTurns?: number, agentSpawns?: number, peakContext?: number, durationMin?: number }|null} tokenStats
 * @property {{ running: boolean, activationsToday?: number, lastActivation?: Date, lastFlag?: string }|null} guardStatus
 * @property {{ signal: string, reason: string }|null} advisory
 * @property {import('../analytics/rates.js').RateData|null} [rates]
 * @property {number} [compactionCount]
 * @property {{ mcpFailures?: number }|null} [healthSummary]
 * @property {import('../collectors/rtk-reader.js').RtkStats|null} [rtkStats]
 * @property {Array<{ type?: string, severity?: string, ratio?: number, reads?: number, edits?: number, message?: string }>} [anomalies]
 * @property {Record<string, number>} [toolCounts]
 * @property {string|null} [sessionId]
 * @property {number} [activeSessionCount]
 * @property {boolean} narrow
 */

const LINE_RENDERERS = [
  renderModelLine,
  renderContextLine,
  renderUsageLine,
  renderTokensLine,
  renderEnvLine,
  renderMcpsLine,
  renderGuardLine,
  renderAdvisorLine,
];

/**
 * Render all 8 HUD lines and print to stdout.
 * @param {RenderContext} ctx
 */
export function render(ctx) {
  const terminalWidth = getTerminalWidth();
  ctx.narrow = isNarrowTerminal();

  const outputLines = LINE_RENDERERS.map(fn => fn(ctx));

  const physicalLines = outputLines.flatMap(line => line.split('\n'));
  const visibleLines = terminalWidth
    ? physicalLines.flatMap(line => wrapLineToWidth(line, terminalWidth))
    : physicalLines;

  for (const line of visibleLines) {
    console.log(`${RESET}${sanitizeForPlain(line)}`);
  }
}
