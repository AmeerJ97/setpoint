/**
 * Perceptually uniform color interpolation in Oklab.
 *
 * Oklab (Björn Ottosson, 2020) is the perceptual color space we want
 * for gradients because HSL crosses a dead gray zone mid-ramp and
 * yellow is dramatically brighter than blue at the same L*. Interpolating
 * linearly in Oklab gives smooth gradients with uniform perceived
 * lightness — the thing matplotlib's cividis/viridis is famous for.
 *
 * Reference: https://bottosson.github.io/posts/oklab/
 *            https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl
 *
 * Zero runtime deps. Colors are RGB tuples [r, g, b] in 0-255.
 */

/**
 * @typedef {[number, number, number]} RGB
 */

/**
 * sRGB [0,255] → linear RGB [0,1]. Reverses the gamma curve.
 */
function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Linear RGB [0,1] → sRGB [0,255] (integer). Applies gamma.
 */
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Convert linear RGB → Oklab. From the reference implementation.
 */
function linearRgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, // L
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, // a
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s, // b
  ];
}

/**
 * Convert Oklab → linear RGB. Inverse of the above.
 */
function oklabToLinearRgb(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** @param {RGB} rgb @returns {[number, number, number]} Oklab triple */
export function rgbToOklab([r, g, b]) {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  return linearRgbToOklab(rl, gl, bl);
}

/** @param {[number, number, number]} oklab @returns {RGB} */
export function oklabToRgb([L, a, b]) {
  const [rl, gl, bl] = oklabToLinearRgb(L, a, b);
  return [linearToSrgb(rl), linearToSrgb(gl), linearToSrgb(bl)];
}

/**
 * Interpolate two RGB colors via Oklab.
 * @param {RGB} a
 * @param {RGB} b
 * @param {number} t - 0..1
 * @returns {RGB}
 */
export function mix(a, b, t) {
  const ta = Math.max(0, Math.min(1, t));
  const labA = rgbToOklab(a);
  const labB = rgbToOklab(b);
  const blended = [
    labA[0] + (labB[0] - labA[0]) * ta,
    labA[1] + (labB[1] - labA[1]) * ta,
    labA[2] + (labB[2] - labA[2]) * ta,
  ];
  return oklabToRgb(blended);
}

/**
 * Parse a 6-digit hex string ("#0d1b3c") into RGB. No shorthand.
 * @param {string} hex
 * @returns {RGB}
 */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * Build a gradient function from an array of hex control points.
 * Returns sample(t in 0..1) → RGB.
 *
 * @param {string[]} hexStops
 * @returns {(t: number) => RGB}
 */
export function makeGradient(hexStops) {
  if (!hexStops || hexStops.length === 0) {
    throw new Error('makeGradient requires at least one stop');
  }
  const stops = hexStops.map(hexToRgb);
  if (stops.length === 1) return () => stops[0];
  const nSeg = stops.length - 1;
  return (t) => {
    const tc = Math.max(0, Math.min(1, t));
    const pos = tc * nSeg;
    const i = Math.min(nSeg - 1, Math.floor(pos));
    const local = pos - i;
    return mix(stops[i], stops[i + 1], local);
  };
}

/**
 * Emit a 24-bit ANSI foreground escape for an RGB tuple.
 * @param {RGB} rgb
 * @returns {string}
 */
export function ansiTrueColor([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Quantize an RGB color to the xterm-256 palette (colors 16-231 form
 * a 6×6×6 cube; 232-255 are the grayscale ramp). Returns the ANSI
 * escape for the nearest match.
 * @param {RGB} rgb
 * @returns {string}
 */
export function ansi256FromRgb([r, g, b]) {
  // Grayscale check: if r≈g≈b use the 24-step gray ramp.
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    const gray = Math.round((r + g + b) / 3);
    if (gray < 8) return '\x1b[38;5;16m';
    if (gray > 248) return '\x1b[38;5;231m';
    return `\x1b[38;5;${232 + Math.round((gray - 8) / 10)}m`;
  }
  const q = c => Math.min(5, Math.round(c / 51)); // 0..5
  const idx = 16 + 36 * q(r) + 6 * q(g) + q(b);
  return `\x1b[38;5;${idx}m`;
}

/**
 * Quantize to the 16-color ANSI palette by nearest match in Oklab.
 * @param {RGB} rgb
 * @returns {string}
 */
export function ansi16FromRgb(rgb) {
  // Classic 16 SGR palette (black, red, green, yellow, blue, magenta,
  // cyan, white, + bright variants). These rgb values are terminal-
  // agnostic approximations; individual themes differ.
  const PALETTE = [
    { code: 30, rgb: [  0,   0,   0] }, { code: 31, rgb: [170,   0,   0] },
    { code: 32, rgb: [  0, 170,   0] }, { code: 33, rgb: [170,  85,   0] },
    { code: 34, rgb: [  0,   0, 170] }, { code: 35, rgb: [170,   0, 170] },
    { code: 36, rgb: [  0, 170, 170] }, { code: 37, rgb: [170, 170, 170] },
    { code: 90, rgb: [ 85,  85,  85] }, { code: 91, rgb: [255,  85,  85] },
    { code: 92, rgb: [ 85, 255,  85] }, { code: 93, rgb: [255, 255,  85] },
    { code: 94, rgb: [ 85,  85, 255] }, { code: 95, rgb: [255,  85, 255] },
    { code: 96, rgb: [ 85, 255, 255] }, { code: 97, rgb: [255, 255, 255] },
  ];

  const target = rgbToOklab(rgb);
  let bestCode = 37;
  let bestDist = Infinity;
  for (const { code, rgb: pr } of PALETTE) {
    const lab = rgbToOklab(pr);
    const dL = target[0] - lab[0];
    const da = target[1] - lab[1];
    const db = target[2] - lab[2];
    const d = dL * dL + da * da + db * db;
    if (d < bestDist) { bestDist = d; bestCode = code; }
  }
  return `\x1b[${bestCode}m`;
}
