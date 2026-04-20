/**
 * Adaptive grid renderer for `setpoint context`.
 *
 * Native /context picks grid dimensions based on the model's window size:
 *   200K models → 10×10 (1 cell = 1% = 2K tokens)
 *   1M  models → 20×10 (1 cell = 0.5% = 5K tokens)
 *   narrow terminals → 5×5 / 5×10
 *
 * We mirror that logic. Each bucket gets its own glyph + color so a
 * glance reads the breakdown the same way it reads on the native grid.
 *
 * Footer prints a numbered legend with K (thousand-tokens) and percent
 * for every bucket.
 */

import { dim, bold, RESET } from '../display/colors.js';

/**
 * Glyph palette for buckets — distinct shapes per bucket so a B/W
 * terminal can still distinguish them. Order matches buildBucketReport's
 * bucket order so the same index → same glyph across runs.
 *
 * Free Space and Autocompact Buffer use restrained glyphs so they read
 * as background, not foreground (matches the native grid's visual hierarchy).
 */
const BUCKET_GLYPHS = {
  'System Prompt':     { glyph: '█', color: '\x1b[36m' },        // cyan
  'System Tools':      { glyph: '▓', color: '\x1b[34m' },        // blue
  'MCP Tools':         { glyph: '▒', color: '\x1b[35m' },        // magenta
  'Custom Agents':     { glyph: '◆', color: '\x1b[33m' },        // yellow
  'Memory Files':      { glyph: '●', color: '\x1b[32m' },        // green
  'Skills':            { glyph: '◇', color: '\x1b[32;2m' },      // dim green
  'Messages':          { glyph: '█', color: '\x1b[37m' },        // white
  'Free Space':        { glyph: '·', color: '\x1b[2m' },         // dim
  'Autocompact Buffer':{ glyph: '░', color: '\x1b[2m' },         // dim
};

const FALLBACK_GLYPH = { glyph: '?', color: '' };

/**
 * Decide grid dimensions from the context window and the available
 * terminal width. For very narrow terminals we drop to 5 cols × 5 rows
 * so the legend still fits.
 *
 * @param {number} contextWindow tokens
 * @param {number} terminalCols
 * @returns {{ cols: number, rows: number, tokensPerCell: number }}
 */
export function chooseDimensions(contextWindow, terminalCols = 80) {
  let cols, rows;
  if (terminalCols < 50) {
    cols = 5; rows = 5;
  } else if (terminalCols < 80) {
    cols = 5; rows = 10;
  } else if (contextWindow >= 1_000_000) {
    cols = 20; rows = 10;
  } else {
    cols = 10; rows = 10;
  }
  const tokensPerCell = Math.max(1, Math.round(contextWindow / (cols * rows)));
  return { cols, rows, tokensPerCell };
}

/**
 * Build the cell array. Walks buckets in display order and packs cells
 * left-to-right, top-to-bottom. Each bucket grabs `ceil(tokens / tokensPerCell)`
 * cells, with a 1-cell minimum if the bucket is non-empty (so a 500-token
 * bucket still shows up rather than vanishing into rounding).
 *
 * @param {import('./buckets.js').BucketReport} report
 * @param {number} cols
 * @param {number} rows
 * @param {number} tokensPerCell
 * @returns {{ glyph: string, color: string, bucket: string }[]}
 */
export function buildCells(report, cols, rows, tokensPerCell) {
  const totalCells = cols * rows;
  const cells = [];

  // Build the renderable bucket sequence: display buckets, then Free + Buffer
  // last so they appear at the end of the grid (matches /context).
  const sequence = [
    ...report.buckets,
    { name: 'Free Space',         tokens: report.freeSpace },
    { name: 'Autocompact Buffer', tokens: report.autocompactBuffer },
  ];

  for (const b of sequence) {
    if (b.tokens <= 0) continue;
    let count = Math.max(1, Math.round(b.tokens / tokensPerCell));
    const meta = BUCKET_GLYPHS[b.name] ?? FALLBACK_GLYPH;
    for (let i = 0; i < count; i++) {
      if (cells.length >= totalCells) return cells;
      cells.push({ glyph: meta.glyph, color: meta.color, bucket: b.name });
    }
  }

  // Pad with Free Space if we under-allocated (rounding can leave gaps).
  while (cells.length < totalCells) {
    const meta = BUCKET_GLYPHS['Free Space'];
    cells.push({ glyph: meta.glyph, color: meta.color, bucket: 'Free Space' });
  }

  return cells;
}

/**
 * Render the grid + legend as a multi-line string ready for stdout.
 * @param {import('./buckets.js').BucketReport} report
 * @param {number} [terminalCols]
 * @returns {string}
 */
export function renderGrid(report, terminalCols = 80) {
  const { cols, rows, tokensPerCell } = chooseDimensions(report.contextWindow, terminalCols);
  const cells = buildCells(report, cols, rows, tokensPerCell);

  const lines = [];
  lines.push(bold(`Context: ${formatK(report.totalTokens)}/${formatK(report.contextWindow)} (${pct(report.totalTokens, report.contextWindow)}%)  ${dim(report.modelLabel)}`));
  lines.push('');

  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    const row = cells.slice(start, start + cols);
    const rendered = row.map(c => `${c.color}${c.glyph}${RESET}`).join(' ');
    lines.push('  ' + rendered);
  }

  lines.push('');
  lines.push(dim(`each cell ≈ ${formatK(tokensPerCell)} tokens (${cols}×${rows})`));
  lines.push('');

  // Legend
  const legendBuckets = [
    ...report.buckets,
    { name: 'Free Space',         tokens: report.freeSpace, source: 'remainder' },
    { name: 'Autocompact Buffer', tokens: report.autocompactBuffer, source: '16.5% reservation' },
  ];

  const widest = Math.max(...legendBuckets.map(b => b.name.length));
  for (const b of legendBuckets) {
    const meta = BUCKET_GLYPHS[b.name] ?? FALLBACK_GLYPH;
    const swatch = `${meta.color}${meta.glyph}${RESET}`;
    const name = b.name.padEnd(widest);
    const tokensStr = formatK(b.tokens).padStart(7);
    const pctStr = `${pct(b.tokens, report.contextWindow).toString().padStart(3)}%`;
    const source = b.source ? dim(`  ${b.source}`) : '';
    lines.push(`  ${swatch}  ${name}  ${tokensStr}  ${pctStr}${source}`);
  }

  if (report.approximate) {
    lines.push('');
    lines.push(dim('approximate — native /context is authoritative; bucket totals from on-disk sources + JSONL'));
  }

  return lines.join('\n') + '\n';
}

/**
 * Render a compact inline grid body — no header, no legend, no footer.
 *
 * Returns an array of lines (one per grid row) for embedding in the HUD
 * right column. The visual contract matches `renderGrid` (same glyphs,
 * same colors, same bucket order) so the inline version and the
 * `setpoint context` CLI read the same way.
 *
 * A single title row precedes the grid (`Context 42K/200K (21%)`) so the
 * user has a reference for the body. Pass `{ noTitle: true }` to omit it.
 *
 * @param {import('./buckets.js').BucketReport} report
 * @param {object} [opts]
 * @param {number} [opts.cols=10]
 * @param {number} [opts.rows=10]
 * @param {boolean} [opts.noTitle=false]
 * @returns {string[]}
 */
export function renderInlineGrid(report, opts = {}) {
  const cols = opts.cols ?? 10;
  const rows = opts.rows ?? 10;
  const tokensPerCell = Math.max(1, Math.round(report.contextWindow / (cols * rows)));
  const cells = buildCells(report, cols, rows, tokensPerCell);

  const lines = [];
  if (!opts.noTitle) {
    lines.push(dim(`Context ${formatK(report.totalTokens)}/${formatK(report.contextWindow)} (${pct(report.totalTokens, report.contextWindow)}%)`));
  }
  for (let r = 0; r < rows; r++) {
    const start = r * cols;
    const row = cells.slice(start, start + cols);
    // No space separator — tight packing so 10 cells fit in 10 chars for
    // narrow right-column budgets. CLI version keeps spacing.
    const rendered = row.map(c => `${c.color}${c.glyph}${RESET}`).join('');
    lines.push(rendered);
  }
  return lines;
}

function formatK(n) {
  if (!Number.isFinite(n)) return '?';
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(part, whole) {
  if (!whole || whole <= 0) return 0;
  return Math.round((part / whole) * 100);
}
