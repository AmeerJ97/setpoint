/**
 * Guard line — inventory-first enforcement status.
 *
 * Phase 6C layout (compact, fits 80-col budget):
 *   Guard  ✓17/17 │ ↻4 today (last:brevity 2m) │ [shaded 17-glyph ribbon]
 *   Guard  ◐14/17 │ ○3 skipped │ quiet │ [ribbon]
 *   Guard  ✗ DOWN 17 unprotected — run systemctl --user start claude-quality-guard
 *
 * Changes from the v1 layout:
 *   - "held" text dropped (redundant with ✓/◐ glyph).
 *   - last-flag + count collapsed to a single field "↻N today (last:X Nm)".
 *   - `top:` field removed (the shaded ribbon already surfaces frequency).
 *   - ribbon encodes revert frequency via shade — eye-scannable heatmap.
 */
import { dim, green, yellow, red, cyan } from '../colors.js';
import { padLabel } from '../format.js';
import { loadDefaults } from '../../data/defaults.js';
import {
  RE_RATIO_HEALTHY,
  RE_RATIO_WARN,
  countReadEdits,
  calculateRatio,
} from '../../anomaly/constants.js';

const SEP = ` ${dim('│')} `;

/**
 * Stable category order — matches defaults.json + the Rust guard's catalog.
 * Used by the ribbon so the same column always means the same flag and
 * eyes can learn it. Reading from defaults preserves dynamic count, but
 * Object key order is insertion-order (reliable in modern JS).
 *
 * @returns {string[]}
 */
function categoryOrder() {
  try {
    const cats = loadDefaults().guard?.categories;
    if (cats && typeof cats === 'object') return Object.keys(cats);
  } catch { /* fall through */ }
  return [];
}

/**
 * Map a flag name (e.g. `tengu_swann_brevity` or `pewter_kestrel.global` —
 * note the log writer strips the `tengu_` prefix) to its category. This
 * lets the ribbon highlight the cell whose flag just got reverted.
 */
const FLAG_TO_CATEGORY = {
  swann_brevity: 'brevity',
  sotto_voce: 'quiet',
  quiet_fern: 'quiet',
  quiet_hollow: 'quiet',
  summarize_tool_results: 'summarize',
  amber_wren: 'maxtokens',
  pewter_kestrel: 'truncation',
  willow_refresh_ttl_hours: 'refresh_ttl',
  willow_census_ttl_hours: 'refresh_ttl',
  claudeai_mcp_connectors: 'mcp_connect',
  bridge: 'bridge',
  grey_step: 'grey_step',
  grey_step2: 'grey_step2',
  grey_wool: 'grey_wool',
  crystal_beam: 'thinking',
  willow_mode: 'willow_mode',
  sm_compact_config: 'compact_max',
  sm_config: 'compact_init',
  tool_result_persistence: 'tool_persist',
  chomp_inflection: 'chomp',
};

/**
 * Total categories the guard knows about. Read live from
 * config/defaults.json (`guard.categories`) so adding or removing a
 * category in one place updates the display in lockstep — no more
 * silent drift between the hardcoded 17 and reality.
 *
 * @returns {number}
 */
function totalCategories() {
  try {
    const cats = loadDefaults().guard?.categories;
    if (cats && typeof cats === 'object') {
      const n = Object.keys(cats).length;
      if (n > 0) return n;
    }
  } catch { /* fall through */ }
  return 17;
}

/**
 * @param {import('../renderer.js').RenderContext} ctx
 * @returns {string}
 */
export function renderGuardLine(ctx) {
  const narrow = ctx.narrow;
  const label = padLabel(narrow ? 'Grd' : 'Guard', narrow);
  const guard = ctx.guardStatus;
  const total = totalCategories();

  if (!guard || !guard.running) {
    return `${dim(label)} ${red('✗ DOWN')} ${dim(`${total} unprotected`)} ${dim('— run systemctl --user start claude-quality-guard')}`;
  }

  const skipped = guard.skippedCount ?? 0;
  const held = Math.max(0, total - skipped);
  const allHeld = skipped === 0;

  const parts = [];

  // Primary inventory — counts first. "held" text dropped; the ✓/◐ glyph
  // already carries the meaning and saves characters for the ribbon.
  const glyph = allHeld ? green('✓') : yellow('◐');
  const inventory = allHeld ? green(`${held}/${total}`)
                            : yellow(`${held}/${total}`);
  parts.push(`${glyph}${inventory}`);

  // Skipped categories surfaced as a first-class state (Alertmanager
  // "silenced" analogue — not collapsed into "ok").
  if (skipped > 0) {
    parts.push(`${yellow('○')}${skipped} ${dim('skipped')}`);
  }

  // Activity field — collapsed to a single column. "↻N today (last:X Nm)".
  // One chunk instead of two saves a separator and keeps all activity
  // signal grouped. `top:` is dropped entirely; the ribbon now encodes
  // frequency via shade.
  const count = guard.activationsToday ?? 0;
  if (count > 0 && guard.lastActivation && guard.lastFlag) {
    const ago = formatAgo(guard.lastActivation).replace(' ago', '');
    parts.push(`${dim('↻')}${count} ${dim('today')} ${dim('(last:')}${cyan(guard.lastFlag)} ${dim(`${ago})`)}`);
  } else {
    parts.push(dim('quiet'));
  }

  // R:E quality badge — moved here from the Tokens line (HUD-SPEC §7).
  // The ratio is a reasoning-quality signal and belongs next to the other
  // quality-enforcement state. Wide mode gets the full `(Nr/Me) status`
  // trailer; narrow mode keeps just the colored ratio so the column still
  // surfaces the signal in 80-col terminals.
  const re = deriveReadEditBadge(ctx, narrow);
  if (re) parts.push(re);

  // 17-glyph ribbon — wide-mode preferred. One char per category,
  // color-coded. Skipped categories use a hollow circle so they read as
  // "intentional gap" rather than "broken"; recently-reverted ones light
  // up cyan to draw the eye to the noisy flags. Narrow mode can't afford
  // 17 cells, so it falls back to a single-char digest of the most recent
  // reverted category's shade — heatmap signal stays visible even below
  // 100 cols.
  const ribbon = narrow ? renderRibbonDigest(guard) : renderRibbon(guard);
  if (ribbon) parts.push(ribbon);

  return `${dim(label)} ${parts.join(SEP)}`;
}

/**
 * Render the R:E badge. Wide: `R:E 4.2 (28r/7e) healthy`. Narrow: `R:E 4.2`.
 * Returns null when there's no read/edit activity yet — no placeholder.
 * @param {import('../renderer.js').RenderContext} ctx
 * @param {boolean} narrow
 * @returns {string|null}
 */
function deriveReadEditBadge(ctx, narrow) {
  const metrics = ctx.advisory?.metrics;
  let reads, edits, ratio;
  if (metrics && (metrics.reads > 0 || metrics.edits > 0)) {
    reads = metrics.reads; edits = metrics.edits;
    ratio = Number.isFinite(metrics.ratio)
      ? metrics.ratio
      : calculateRatio(reads, edits);
  } else {
    const c = countReadEdits(ctx.toolCounts ?? {});
    reads = c.reads; edits = c.edits;
    ratio = calculateRatio(reads, edits);
  }
  if (reads <= 0 && edits <= 0) return null;

  const infinite = !Number.isFinite(ratio);
  const ratioStr = infinite ? '\u221e' : ratio.toFixed(1);
  const colorFn = infinite || ratio >= RE_RATIO_HEALTHY ? green
                : ratio >= RE_RATIO_WARN               ? yellow
                : red;
  const status = infinite || ratio >= RE_RATIO_HEALTHY ? 'healthy'
               : ratio >= RE_RATIO_WARN               ? 'ok'
               : 'degraded';

  // Narrow: ratio-only, no counts, no status word. Wide: full trailer.
  if (narrow) {
    if (edits <= 0) return `${cyan('R:E')} ${dim('--')}`;
    return `${cyan('R:E')} ${colorFn(ratioStr)}`;
  }
  if (edits <= 0) {
    return `${cyan('R:E')} ${dim(`-- (${reads}r/0e)`)}`;
  }
  return `${cyan('R:E')} ${colorFn(ratioStr)} ${dim(`(${reads}r/${edits}e)`)} ${colorFn(status)}`;
}

/**
 * Narrow-mode ribbon digest — a single cell summarizing the noisiest flag.
 * Priority:
 *   - if a flag has just been reverted → cyan ▲ (same glyph as wide mode)
 *   - else peak per-category shade (the worst of the revert counts)
 *   - else a single green █ so the affordance remains visible
 * Keeps the heatmap signal alive in terminals below the 100-col cut.
 * @returns {string|null}
 */
function renderRibbonDigest(guard) {
  if (!guard) return null;
  if (guard.lastFlag) {
    const head = guard.lastFlag.split('.')[0];
    if (FLAG_TO_CATEGORY[head]) return cyan('▲');
  }
  let peak = 0;
  for (const [flag, n] of Object.entries(guard.flagCounts ?? {})) {
    const head = flag.split('.')[0];
    if (!FLAG_TO_CATEGORY[head]) continue;
    if (n > peak) peak = n;
  }
  return shadeForCount(peak);
}

/**
 * Render a one-char-per-category ribbon with shade-encoded frequency.
 *
 *   green █ — held, 0 reverts today
 *   green ▇ — 1 revert today
 *   yellow ▆ — 2-3 reverts today
 *   yellow ▅ — 4-7 reverts today
 *   red ▄ — 8+ reverts today
 *   dim ○ — skipped (.skip file present)
 *   cyan ▲ — most-recently-reverted category (overrides shade)
 *
 * Rationale: binary █/▲ couldn't distinguish "got reverted once" from
 * "Anthropic is hammering this flag" — the shaded form gives a density
 * read at a glance. Column order is stable (matches defaults.json) so
 * the eye learns what each column means and can spot drift.
 */
function renderRibbon(guard) {
  const order = categoryOrder();
  if (order.length === 0) return null;

  const skipped = new Set(guard.skippedCategories ?? []);

  // Aggregate revert counts by category (flagCounts keys are
  // tengu_-stripped and may have `.subkey` suffixes).
  const revertCounts = new Map();
  for (const [flag, n] of Object.entries(guard.flagCounts ?? {})) {
    const head = flag.split('.')[0];
    const cat = FLAG_TO_CATEGORY[head];
    if (!cat) continue;
    revertCounts.set(cat, (revertCounts.get(cat) ?? 0) + n);
  }

  // Most-recently-reverted category — highlighted regardless of shade.
  const lastHead = (guard.lastFlag ?? '').split('.')[0];
  const lastCat = FLAG_TO_CATEGORY[lastHead] ?? null;

  const cells = order.map(cat => {
    if (skipped.has(cat)) return dim('○');
    if (cat === lastCat)  return cyan('▲');
    const n = revertCounts.get(cat) ?? 0;
    return shadeForCount(n);
  });
  return cells.join('');
}

/**
 * Map a per-category revert count to a shaded glyph + color. Thresholds:
 *   0        → █ green
 *   1        → ▇ green
 *   2-3      → ▆ yellow
 *   4-7      → ▅ yellow
 *   8+       → ▄ red
 */
function shadeForCount(n) {
  if (n <= 0) return green('█');
  if (n === 1) return green('▇');
  if (n < 4)  return yellow('▆');
  if (n < 8)  return yellow('▅');
  return red('▄');
}

/** @param {Date} date */
function formatAgo(date) {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
