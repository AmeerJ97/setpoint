/**
 * Sparkline renderer using Unicode block elements.
 * ▁▂▃▄▅▆▇█ — 8 levels for inline mini-charts.
 */

const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a sparkline from an array of numbers.
 * @param {number[]} values
 * @param {number} [width] - max chars; truncates from left if values exceed
 * @returns {string}
 */
export function sparkline(values, width) {
  if (!values || values.length === 0) return '';
  const data = width && values.length > width ? values.slice(-width) : values;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  return data.map(v => {
    const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, idx))];
  }).join('');
}

/**
 * Render a mini bar (single character) showing a percentage.
 * @param {number} percent - 0-100
 * @returns {string}
 */
export function miniBar(percent) {
  const idx = Math.round((Math.min(100, Math.max(0, percent)) / 100) * (SPARK_CHARS.length - 1));
  return SPARK_CHARS[idx];
}
