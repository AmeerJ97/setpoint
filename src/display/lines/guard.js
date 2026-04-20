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

  // 17-glyph ribbon — wide-mode only. One char per category, color-coded.
  // Skipped categories use a hollow circle so they read as "intentional gap"
  // rather than "broken"; recently-reverted ones light up cyan to draw the
  // eye to the noisy flags.
  if (!narrow) {
    const ribbon = renderRibbon(guard);
    if (ribbon) parts.push(ribbon);
  }

  return `${dim(label)} ${parts.join(SEP)}`;
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
