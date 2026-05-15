# Advisor logistic-regression classifier

A 3-class softmax logistic regression over four session features.
**Advisory only** — the classifier never rewrites the rule-derived
action from `src/advisor/engine.js`. Its job is to flag cases where
the threshold rules and the learned model disagree, which the HUD
surfaces as a demoted confidence badge + a `lr:risk {p}` salience
segment.

## Features

| Index | Name                  | Source                                             |
|-------|-----------------------|----------------------------------------------------|
| 0     | `readEditRatio`       | reads ÷ max(edits, 1), capped at 20                |
| 1     | `burnVelocityVsP50`   | current burn ÷ personal P50 baseline (`1.0` = typical) |
| 2     | `contextPct`          | 0–100, same value the HUD bar uses                  |
| 3     | `reversalsPer1k`      | reasoning-reversal count per 1000 tool calls       |

Feature order is load-bearing — changing it requires retraining AND
updating `FEATURE_NAMES` in `src/advisor/classifier.js`.

## Classes

`['healthy', 'watch', 'risk']` — derived at training time from the
existing rule-based advisor signal:

| Signal on training row | Label    |
|------------------------|----------|
| `increase`, `nominal`  | healthy  |
| `reduce`               | watch    |
| `throttle`, `limit_hit`| risk     |

This means the first generation of the classifier bootstraps from
the rules. The value comes later — as you retrain against your
accumulated history, the classifier diverges to catch patterns the
rules miss.

## Training

Training lives in Python and delegates to a compatible local
multi-class softmax + mini-batch SGD repo. Point the trainer at that
repo explicitly with `--lr-repo`, or export `CLAUDE_OPS_LR_REPO`.

```bash
# Re-train against your full history and an explicit LR repo:
python research/train-advisor-classifier.py \
    --lr-repo /path/to/Multi-class-Logistic-Regression-and-Mini-Batch-Stochastic-Gradient-Descent

# Or explicitly:
python research/train-advisor-classifier.py \
    --lr-repo /path/to/Multi-class-Logistic-Regression-and-Mini-Batch-Stochastic-Gradient-Descent \
    --history ~/.claude/plugins/claude-ops/usage-history.jsonl \
    --out src/advisor/classifier-weights.json
```

Output shape: `(D+1, C)` — four feature rows + one bias row, three
class columns. MinMaxScaler min/max is stored alongside so the JS
inference side can replicate the normalization without sklearn.

Weights file is **gitignored** — it's personal training data. The
vendored fallback at `classifier-weights.default.json` ships with
the repo so fresh installs have a sensible bootstrap.

## Inference

Pure JS, stdlib only, ~40 lines in `src/advisor/classifier.js`:

```js
import { predictProba, featuresFromMetrics } from './classifier.js';
const features = featuresFromMetrics(advisory.metrics);
const prediction = predictProba(features);
// { topClass: 'risk', topProb: 0.83, probabilities: { healthy: 0.05, watch: 0.12, risk: 0.83 } }
```

Numerical stability uses the standard log-sum-exp trick (subtract
max logit before exp). Matches the user's Python training loop.

## Engine integration

Current policy (see `src/advisor/engine.js`):

```
if classifier.probabilities.risk > 0.7
   AND rule-based signal ∈ {increase, nominal}
   AND confidence == 'high':
     demote confidence → 'med'
     explain why in confidenceWhy
```

Rule-derived `signal` and `action` are never overridden. Expand
this policy as confidence in the classifier grows.

## Salience surface

The Advisor line's trailing salience slot adds a dim
`lr:risk 0.78` chip when `risk > 0.6` AND no higher-priority
salience (burn-velocity anomaly, peak dominance, R:E) fired. See
`src/display/lines/advisor-salience.js`.

## Graceful fallback

If the weights file is missing, malformed, or shaped wrong, both
`loadWeights()` and `predictProba()` return `null`. The engine's
integration is wrapped to treat `null` as "classifier unavailable"
— advisor confidence stays at its original rule-derived level,
nothing is surfaced. No hard dependency.
