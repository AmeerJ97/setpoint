/**
 * Display renderer — orchestrates 8-line HUD output.
 * Two-column layout when terminal >= 100 chars wide.
 * All lines always visible. Active = white, inactive = dim gray.
 */

import { RESET, dim } from './colors.js';
import { getTerminalWidth, isNarrowTerminal } from './terminal.js';
import { visualLength, sliceVisible, wrapLineToWidth } from './text.js';
import { renderRightColumns } from './right-column.js';
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

const TWO_COL_MIN_WIDTH = 100;
const SEPARATOR = dim(' │ ');
const SEPARATOR_VISUAL_LEN = 3;

/**
 * Render all 8 HUD lines and print to stdout.
 * @param {RenderContext} ctx
 */
export function render(ctx) {
  const terminalWidth = getTerminalWidth();
  ctx.narrow = isNarrowTerminal();

  const leftLines = LINE_RENDERERS.map(fn => fn(ctx));
  const useTwoCol = terminalWidth && terminalWidth >= TWO_COL_MIN_WIDTH;

  let outputLines;

  if (useTwoCol) {
    const rightLines = renderRightColumns(ctx);
    const maxLeftVisual = Math.max(...leftLines.map(l => visualLength(l)));
    const leftColWidth = Math.min(maxLeftVisual, Math.floor(terminalWidth * 0.6));
    const rightColWidth = terminalWidth - leftColWidth - SEPARATOR_VISUAL_LEN;

    outputLines = leftLines.map((left, i) => {
      const right = rightLines[i] || '';
      const leftVis = visualLength(left);
      const padNeeded = Math.max(0, leftColWidth - leftVis);
      const paddedLeft = left + ' '.repeat(padNeeded);
      const rightTruncated = visualLength(right) > rightColWidth
        ? sliceVisible(right, rightColWidth)
        : right;
      return `${paddedLeft}${SEPARATOR}${rightTruncated}`;
    });
  } else {
    outputLines = leftLines;
  }

  const physicalLines = outputLines.flatMap(line => line.split('\n'));
  const visibleLines = terminalWidth
    ? physicalLines.flatMap(line => wrapLineToWidth(line, terminalWidth))
    : physicalLines;

  for (const line of visibleLines) {
    console.log(`${RESET}${sanitizeForPlain(line)}`);
  }
}
