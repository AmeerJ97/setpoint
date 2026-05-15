/**
 * Logistic-regression anomaly classifier — inference side.
 *
 * Trained in Python against a compatible local multi-class softmax +
 * mini-batch SGD repo using `research/train-advisor-classifier.py`.
 * The training script
 * writes weights + scaler params to
 * `src/advisor/classifier-weights.json`; this module loads them,
 * caches, and offers a pure inference predicate.
 *
 * Features (order matters, must match training):
 *   0: readEditRatio        (reads ÷ max(edits, 1), capped at 20)
 *   1: burnVelocityVsP50    (current burn ÷ personal P50; 1.0 = typical)
 *   2: contextPct           (0–100)
 *   3: reversalsPer1k       (reasoning reversals per 1000 tool calls)
 *
 * Classes (order matters, must match training):
 *   0: healthy
 *   1: watch
 *   2: risk
 *
 * The classifier is strictly advisory — it never blocks or rewrites
 * the rule-derived signal. Engine uses the returned `risk` probability
 * to nudge its confidence level (see engine.js integration).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEIGHTS = join(__dirname, 'classifier-weights.default.json');
const USER_WEIGHTS    = join(__dirname, 'classifier-weights.json');

export const CLASSES = ['healthy', 'watch', 'risk'];
export const FEATURE_NAMES = ['readEditRatio', 'burnVelocityVsP50', 'contextPct', 'reversalsPer1k'];

let cached = null;

/**
 * Load weights from disk. Prefers the user's trained weights
 * (`classifier-weights.json`, gitignored) over the vendored default.
 * Returns null if neither file is loadable — caller should then skip
 * classifier logic without failing.
 *
 * @returns {{weights: number[][], scaler: {min: number[], max: number[]}}|null}
 */
export function loadWeights() {
  if (cached !== null) return cached || null;
  const path = existsSync(USER_WEIGHTS) ? USER_WEIGHTS : DEFAULT_WEIGHTS;
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.weights) || !Array.isArray(data?.scaler?.min)) {
      cached = false;
      return null;
    }
    cached = data;
    return data;
  } catch {
    cached = false;
    return null;
  }
}

/** Clear the weights cache (test helper). */
export function resetCache() { cached = null; }

/**
 * @typedef {object} ClassifierPrediction
 * @property {string} topClass       - one of 'healthy' | 'watch' | 'risk'
 * @property {number} topProb        - probability of the top class (0..1)
 * @property {Record<string, number>} probabilities
 */

/**
 * Predict class probabilities for a single observation.
 *
 * @param {Record<string, number>|number[]} features - object with FEATURE_NAMES keys, or a raw array in the same order
 * @param {{weights: number[][], scaler: {min: number[], max: number[]}}} [model] - override; defaults to loadWeights()
 * @returns {ClassifierPrediction|null} null if no weights available or bad input
 */
export function predictProba(features, model = null) {
  const m = model ?? loadWeights();
  if (!m) return null;

  const x = Array.isArray(features)
    ? features
    : FEATURE_NAMES.map(name => Number(features[name]));

  if (x.length !== FEATURE_NAMES.length || x.some(v => !Number.isFinite(v))) return null;

  const { weights, scaler } = m;

  // Min-max normalise to match training scaler.
  const normalised = x.map((v, i) => {
    const span = scaler.max[i] - scaler.min[i];
    return span > 0 ? (v - scaler.min[i]) / span : 0;
  });

  // Append bias term and multiply by weights (shape: (F+1) × C).
  const withBias = [...normalised, 1.0];
  const nRows = weights.length;     // should equal FEATURE_NAMES.length + 1
  const nCols = weights[0]?.length ?? 0;
  if (nRows !== withBias.length || nCols !== CLASSES.length) return null;

  const logits = new Array(nCols).fill(0);
  for (let j = 0; j < nCols; j++) {
    let s = 0;
    for (let i = 0; i < nRows; i++) s += withBias[i] * weights[i][j];
    logits[j] = s;
  }

  // Numerically stable softmax (log-sum-exp trick).
  const maxLogit = Math.max(...logits);
  const exps = logits.map(l => Math.exp(l - maxLogit));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  const probs = exps.map(e => e / sum);

  let topIdx = 0;
  for (let j = 1; j < probs.length; j++) if (probs[j] > probs[topIdx]) topIdx = j;

  const probabilities = {};
  for (let j = 0; j < CLASSES.length; j++) probabilities[CLASSES[j]] = probs[j];

  return {
    topClass: CLASSES[topIdx],
    topProb: probs[topIdx],
    probabilities,
  };
}

/**
 * Build a feature vector from the engine's existing `metrics` object.
 * @param {{ratio: number, burnVelocity: number, contextPercent: number, reversalsPer1k?: number}} metrics
 * @returns {Record<string, number>}
 */
export function featuresFromMetrics(metrics) {
  // ratio=Infinity means reads with zero edits — cap to 20 so the
  // classifier sees "healthy-looking all-read" rather than a silent 0.
  const rawRatio = metrics?.ratio;
  const ratio = Number.isFinite(rawRatio)
    ? Math.min(20, rawRatio)
    : (rawRatio === Infinity ? 20 : 0);
  const burnVelocity = Number.isFinite(metrics?.burnVelocity) ? metrics.burnVelocity : 1.0;
  const contextPct = Number.isFinite(metrics?.contextPercent) ? metrics.contextPercent : 0;
  const reversals = Number.isFinite(metrics?.reversalsPer1k) ? metrics.reversalsPer1k : 0;
  return {
    readEditRatio: ratio,
    burnVelocityVsP50: burnVelocity,
    contextPct,
    reversalsPer1k: reversals,
  };
}
