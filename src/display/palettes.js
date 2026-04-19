/**
 * Named color palettes for setpoint.
 *
 * Every palette exposes the same API:
 *   sample(t)        — t in [0,1], returns an RGB tuple (gradient)
 *   stateColor(name) — semantic state ("ok"/"warn"/"critical"/"info"/"mute")
 *                      returns an RGB tuple (qualitative)
 *
 * Design:
 *   • Default palette is "cividis". Equally readable across the three
 *     common colorblindness types (viridis docs, davidmathlogic).
 *   • The "rag" palette preserves the v2.0 green→yellow→red behavior
 *     for users who prefer traditional semantics (SETPOINT_PALETTE=rag).
 *   • State colors are drawn from the Okabe-Ito qualitative palette,
 *     which is colorblind-safe without relying on red/green contrast.
 *
 * All hex values are sRGB and will be interpolated in Oklab by
 * makeGradient() before quantization.
 */

import { makeGradient } from './gradient.js';

/* -------------------------------------------------------------------- */
/* Gradient control points                                              */
/* -------------------------------------------------------------------- */

// cividis 7-stop subsample (Nuñez, Anderton, Renslow 2018). Colorblind-safe.
const CIVIDIS = [
  '#00224e', '#123570', '#3b496c', '#575d6d',
  '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838',
];

// Classic green → yellow → red. Kept for opt-in nostalgia.
const RAG = [
  '#16a34a', '#4ade80', '#fde047', '#facc15', '#fb923c', '#ef4444', '#b91c1c',
];

/* -------------------------------------------------------------------- */
/* Okabe-Ito qualitative accents (state signals)                         */
/* -------------------------------------------------------------------- */

const OKABE_ITO = {
  ok:        '#009E73', // bluish green
  warn:      '#F0E442', // yellow
  critical:  '#D55E00', // vermillion
  info:      '#56B4E9', // sky blue
  attention: '#E69F00', // orange
  mute:      '#999999', // neutral gray
};

// RAG-flavored state colors for users who want red/green/yellow semantics.
const RAG_STATE = {
  ok:        '#22c55e',
  warn:      '#eab308',
  critical:  '#ef4444',
  info:      '#38bdf8',
  attention: '#f97316',
  mute:      '#6b7280',
};

/* -------------------------------------------------------------------- */
/* Palette builder                                                       */
/* -------------------------------------------------------------------- */

function build(name, gradientStops, stateMap) {
  const sampleFn = makeGradient(gradientStops);
  return {
    name,
    sample: sampleFn,
    stateColor(state) {
      const hex = stateMap[state];
      if (!hex) return null;
      return [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ];
    },
  };
}

const PALETTES = {
  cividis: build('cividis', CIVIDIS, OKABE_ITO),
  rag:     build('rag',     RAG,     RAG_STATE),
};

/**
 * Get a named palette. Falls back to cividis for unknown names.
 * @param {string} [name]
 * @returns {{ name: string, sample: (t:number)=>[number,number,number], stateColor: (s:string)=>[number,number,number]|null }}
 */
export function getPalette(name) {
  return PALETTES[name] ?? PALETTES.cividis;
}

/**
 * List available palette names.
 * @returns {string[]}
 */
export function listPalettes() {
  return Object.keys(PALETTES);
}
