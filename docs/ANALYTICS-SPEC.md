# Analytics Engine Specification

## Purpose
Compute rolling usage rates, project limit exhaustion, and generate
actionable effort/model recommendations.

## Data Sources

### Primary: stdin JSON (real-time, per-render)
```json
{
  "rate_limits": {
    "five_hour": { "used_percentage": 62, "resets_at": 1743612000 },
    "seven_day": { "used_percentage": 38, "resets_at": 1744000000 }
  },
  "context_window": {
    "context_window_size": 200000,
    "used_percentage": 48,
    "current_usage": {
      "input_tokens": 30000,
      "output_tokens": 9500,
      "cache_creation_input_tokens": 310000,
      "cache_read_input_tokens": 680000
    }
  }
}
```

**Important:** `current_usage` values represent the current context window state,
not per-turn deltas. For long sessions, `cache_read_input_tokens` can reach millions
(cumulative cache reads across all turns). Anomaly detection must use per-turn output
tokens (from `current_usage.output_tokens`) — never cumulative session totals from
the token stats cache — to avoid false positives on token spike alerts.

### Secondary: Session JONL files (polled every 60s)
Path: ~/.claude/projects/{project-slug}/{session-id}.jsonl
Contains per-turn token usage, tool invocations, model used.

### Tertiary: Guard log
Path: /tmp/claude-quality-guard.log
Contains timestamped override re-application events.

## Rate Calculations

### Short-term rate (5-hour window)
```
consumed_5h = five_hour.used_percentage / 100
time_elapsed_5h = now - (five_hour.resets_at - 5*3600)
time_remaining_5h = five_hour.resets_at - now
rate_per_min = consumed_5h / (time_elapsed_5h / 60)
projected_at_reset = consumed_5h + (rate_per_min * time_remaining_5h / 60)
```

### Long-term rate (7-day window)
```
consumed_7d = seven_day.used_percentage / 100
time_elapsed_7d = now - (seven_day.resets_at - 7*86400)
daily_rate = consumed_7d / (time_elapsed_7d / 86400)
projected_at_reset = consumed_7d + (daily_rate * (seven_day.resets_at - now) / 86400)
```

### Burn rate (session-level, price-weighted + EWMA smoothed)

Phase 1.2 replaced raw tokens-per-minute with a cost-relevance rate. Each
component is weighted by its per-MTok price for the active model so that
a turn which *reads* 100K cache tokens with a tiny output shows real
quota pressure, not near-zero.

```
// weights come from config/defaults.json pricing × cache TTL split
w_in       = input_price
w_out      = output_price
w_cache_c  = cache_write_price   (5m vs 1h split when tier is known)
w_cache_r  = cache_read_price

cost_units = in * w_in + out * w_out + cache_create * w_cache_c + cache_read * w_cache_r
raw_burn   = cost_units / max(session_duration_min, 1) * (1 / output_price)
             // rescale to tokens/min units for display continuity
```

Raw burn is smoothed with exponentially weighted moving average (α = 0.2)
so a single bursty turn doesn't dominate. Both raw and smoothed values
are exposed; the advisor consumes `smoothedBurn`, the Tokens line
displays the smoothed value.

Implementation: `src/analytics/cost.js::perTokenWeights()`,
`src/analytics/cost.js::costWeightedBurnRate()`,
`src/analytics/cost.js::ewmaBurnRate()`.

## Advisory Logic

Phase 2 replaced the static 5-precedence decision matrix with an
action-oriented engine at `src/advisor/engine.js`. The engine evaluates
rungs in order and emits the first one that fires; each rung names a
concrete remedy instead of an abstract effort/model pair.

### Action Ladder (first match wins)

| Rung (`tier`) | Signal | Trigger | Action text |
|---|---|---|---|
| `hard_stop_5h` | `throttle` | 5h TTE > 0 and < 30 min | `stop now — 5h window exhausting in <30 min` |
| `hard_stop_7d` | `throttle` | 7d TTE > 0 and < 12 h | `stop session — 7d budget exhausting in <12h` |
| `model_swap`   | `reduce`   | Opus + peak active + `burnVelocity > 2.5× P50` | `swap Opus → Sonnet (peak burn high)` |
| `clear_session`| `reduce`   | `edits ≥ 3` and R:E ratio < 3.0 | `/clear — model attention degraded (compact won't fix)` |
| `compact_context`| `reduce` | Context % > 60 | `/compact — context > 60%` |
| `ok`           | `increase` | None of the above | `on track — proceed` |
| `limit_hit`    | `limit_hit`| 5h or 7d detail level == `hit` (overrides everything) | `wait for window reset` |

Thresholds are anchored to the user's personal P50/P90 (rolling 30-day
window over `usage-history.jsonl`), with defaults from
`config/defaults.json` until ≥ 7 days of data and ≥ 50 samples exist.
Peak-hour weighting (see `src/analytics/rates.js::projectWindow`) feeds
TTE and burn-velocity inputs.

### Confidence

`confidence ∈ {low, medium, high}` dims the advisor badge when the
session is young. Thresholds:

- `low`:    durationMin < 15 **or** recent turns < 5
- `medium`: durationMin < 60 **or** recent turns < 20
- `high`:   otherwise

### Output Format
```js
// Recommendation (src/advisor/engine.js)
{
  signal:        'increase' | 'nominal' | 'reduce' | 'throttle' | 'limit_hit',
  tier:          'ok' | 'compact_context' | 'clear_session' | 'model_swap'
                 | 'hard_stop_5h' | 'hard_stop_7d' | 'limit_hit',
  action:        '/compact — context > 60%',
  causalReason:  'context 72% used',
  confidence:    'low' | 'medium' | 'high',
  confidenceWhy: '12min / 4 turns',
  metrics: {
    reads: 28, edits: 7, ratio: 4.0,
    burnRate: 211, burnVelocity: 1.2,
    fhTteSec: 9300, sdTteSec: 172000,
    contextPercent: 72, peakActive: false,
  },
  baselines: { burnP50, burnP90, reP50, reP90, samples, daysCovered },
}
```

## Historical Storage

Append-only JSONL at: ~/.claude/plugins/claude-hud/usage-history.jsonl

Each entry:
```json
{
  "ts": "2026-04-02T18:30:00Z",
  "five_hour_pct": 62,
  "seven_day_pct": 38,
  "session_burn_rate": 211,
  "context_pct": 48,
  "signal": "nominal",
  "model": "opus",
  "effort": "high"
}
```

Written every 5 minutes. Used for trend analysis and daily digest.

## Integration Points

### HUD Line 8 (Advisor)
Renders the advisory signal as a single colored line.

### Optional: Desktop notification
If signal transitions from nominal → throttle, send via notify-send.

### Optional: Auto-adjust (future)
If user opts in, advisor could auto-set effortLevel in settings.json.
NOT implemented in v1 — advisory only.
