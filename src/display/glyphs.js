/**
 * Glyph resolver. Maps semantic glyph names to concrete characters
 * based on terminal policy:
 *
 *   SETPOINT_PLAIN=1 → ASCII-only fallbacks (for CI, logs, ssh
 *                      sessions on terminals without Unicode fonts)
 *   SETPOINT_NERD=1  → opt-in Nerd-Font glyphs (branded icons,
 *                      powerline separators). Default: false.
 *   otherwise        → Unicode BMP (default; every modern Claude
 *                      Code user's terminal supports these)
 *
 * Line renderers should use `g('check')` instead of literal '✓' when
 * they want the glyph to survive ASCII-only mode. Most block-element
 * characters (█ ░ ▁-▇) are BMP and don't need a fallback for default
 * usage; they're only mapped here for SETPOINT_PLAIN=1.
 */

import { useNerdGlyphs, usePlainGlyphs } from './capability.js';

/**
 * @typedef {keyof typeof BMP} GlyphName
 */

const BMP = {
  check: '✓',
  cross: '✗',
  warn: '⚠',
  up_triangle: '▲',
  down_triangle: '▼',
  dot_solid: '●',
  dot_hollow: '○',
  dot_half: '◐',
  stack: '⧉',      // "layers" – we use for "N concurrent sessions"
  rotate: '↻',     // rotate/refresh
  arrow_right: '→',
  arrow_up_right: '↗',
  arrow_down_right: '↘',
  arrow_flat: '→',
  arrow_heavy_right: '⇢',
  sep_vert: '│',
  sep_heavy: '━',
  sep_light: '─',
  bracket_open: '⎡',
  bracket_close: '⎤',
  gauge_open: '▕',
  gauge_close: '▏',
  block_full: '█',
  block_dim: '░',
  block_mid: '▓',
  infinity: '∞',
};

const PLAIN = {
  check: '+',
  cross: 'x',
  warn: '!',
  up_triangle: '^',
  down_triangle: 'v',
  dot_solid: '*',
  dot_hollow: '.',
  dot_half: 'o',
  stack: '@',
  rotate: 'r',
  arrow_right: '->',
  arrow_up_right: '/',
  arrow_down_right: '\\',
  arrow_flat: '-',
  arrow_heavy_right: '=>',
  sep_vert: '|',
  sep_heavy: '=',
  sep_light: '-',
  bracket_open: '[',
  bracket_close: ']',
  gauge_open: '|',
  gauge_close: '|',
  block_full: '#',
  block_dim: '.',
  block_mid: '=',
  infinity: 'inf',
};

// Nerd Font powerline + branded glyphs (kept minimal to avoid bloat)
const NERD = {
  ...BMP,
  check: '\uf00c',         //
  cross: '\uf00d',         //
  warn: '\uf071',          //
  dot_solid: '\uf444',     //  ●  (large)
  dot_hollow: '\uf10c',    //  ○
  // Everything else falls through to BMP.
};

/**
 * Resolve a glyph name to the appropriate character for the current
 * environment. Cache the resolved table so repeated calls are O(1).
 * @param {GlyphName} name
 * @returns {string}
 */
let cached = null;
export function g(name) {
  if (!cached) cached = resolveTable();
  return cached[name] ?? name;
}

function resolveTable() {
  if (usePlainGlyphs()) return PLAIN;
  if (useNerdGlyphs())  return NERD;
  return BMP;
}

/**
 * Reset cache. Test-only — callers shouldn't need this.
 */
export function resetGlyphCache() {
  cached = null;
}

/**
 * Post-process a rendered line to downgrade any non-ASCII glyph that
 * has a PLAIN mapping. This lets line renderers use rich Unicode by
 * default without every renderer needing to call g() explicitly —
 * if SETPOINT_PLAIN=1 we sweep the output.
 *
 * Only runs when SETPOINT_PLAIN is set; otherwise no-op.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeForPlain(text) {
  if (!usePlainGlyphs()) return text;
  let out = text;
  for (const [key, plain] of Object.entries(PLAIN)) {
    const bmp = BMP[key];
    if (bmp && bmp !== plain) {
      out = out.split(bmp).join(plain);
    }
  }
  // Also strip the extra block elements that appear as literals in bars
  // and sparklines but aren't keyed in the BMP table.
  const EXTRAS = {
    '▉': '#', '▊': '#', '▋': '#', '▌': '=', '▍': '=', '▎': '-', '▏': '|',
    '▁': '_', '▂': '.', '▃': '.', '▄': ':', '▅': ':', '▆': '=', '▇': '#',
    '⎡': '[', '⎤': ']', '▕': '|',
    '⏱': 't',   // clock → 't' for time
    '△': '^',   // warn triangle outline
    '▎': '|',   // heading chip
  };
  for (const [u, a] of Object.entries(EXTRAS)) out = out.split(u).join(a);
  return out;
}
