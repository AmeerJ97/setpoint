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
    "total_tokens": 72000,
    "total_input_tokens": 30000,
    "total_output_tokens": 9500,
    "total_thinking_tokens": 1500,
    "current_usage": {
      "input_tokens": 30000,
      "output_tokens": 9500,
      "cache_creation_input_tokens": 310000,
      "cache_read_input_tokens": 680000
    }
  },
  "cost": {
    "total_cost_usd": 0.91
  },
  "effort": {
    "level": "high"
  }
}
```

**Important:** `current_usage` values represent the current context window state,
not per-turn deltas. For long sessions, `cache_read_input_tokens` can reach millions
(cumulative cache reads across all turns). Anomaly detection must use per-turn output
tokens (from `current_usage.output_tokens`) — never cumulative session totals from
the token stats cache — to avoid false positives on token spike alerts.

When native totals exist, Claude Ops prefers `context_window.total_tokens`,
`total_input_tokens`, `total_output_tokens`, and `total_thinking_tokens` over
legacy `current_usage` sums. When `cost.total_cost_usd` exists, cost-metered
session display and history use `cost_kind: "api_statusline_actual"` instead
of a local estimate.

### Secondary: Session JSONL files (polled every 30s while active)
Path: ~/.claude/projects/{project-slug}/{session-id}.jsonl
Contains per-turn token usage, tool invocations, model used.

The collector is on-demand by default. Claude Code statusLine renders wake
`claude-ops-analytics.service`; the daemon exits after idle time when no active
Claude Code session is present. Set `CLAUDE_OPS_ANALYTICS_KEEPALIVE=1` only when
continuous collection is explicitly desired.

### Tertiary: Guard log
Path: ~/.claude/plugins/claude-ops/guard.log
Contains timestamped override re-application events.

## Rate Calculations

Rate-window calculations run only in subscription mode, where Claude
Code provides `rate_limits`. When `rate_limits` are absent, Claude Ops
enters cost-metered mode and never renders fake quota percentages or
time-to-exhaustion values.

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

### Cost metrics

Claude Ops tracks two explicit cost concepts:

- `calculateCost()` returns a generation/reference estimate from input
  and output tokens only. This is appropriate for subscription-mode
  context and legacy comparison labels.
- `calculateBillableCost()` returns an API billable estimate. It includes
  input, output, cache writes, cache reads, cache-write TTL split, and
  configured data-residency multipliers.

API-mode 5h/7d HUD values are local spend references from
`usage-history.jsonl` rows marked `cost_kind: "api_billable_estimate"` or
`cost_kind: "api_statusline_actual"`. StatusLine actual rows come directly from
Claude Code's `cost.total_cost_usd`; estimate rows are local Claude Ops
calculations. They are not account limits and do not come from credentialed
provider billing readers. The local reference window excludes the current
session and requires enough historical rows, distinct sessions, and elapsed age
before the HUD/advisor render reference rails. Until then the data maturity
state is `cold_start` or `warming`.

Known model pricing is resolved from `config/defaults.json` with source and
retrieval metadata. Unknown named models do not silently fall back to default
pricing; the HUD marks `price:unknown` and uses zero-priced local estimates
until pricing is configured.

### Vertex provider telemetry

Vertex mode is cost-metered. Claude Ops does not query provider telemetry in
the statusLine render path. Operators can populate a HUD-readable snapshot with:

```bash
claude-ops telemetry vertex collect --json \
  --project "$ANTHROPIC_VERTEX_PROJECT_ID" \
  --region "$CLOUD_ML_REGION" \
  --model "$ANTHROPIC_MODEL"
```

The collector reads Cloud Monitoring token metrics
(`aiplatform.googleapis.com/publisher/online_serving/token_count`) and writes
`~/.claude/plugins/claude-ops/vertex-api-telemetry.json` by default. Token-only
snapshots render as `vertex-metrics-estimate`: useful for usage direction, not
billing authority. A snapshot becomes `vertex-api` only when it has fresh
retrieval metadata, matches the current project/region/model/endpoint, and
contains complete cost fields for both 5h and 7d windows with a cost source.

Required Vertex config audit fields are:

- `CLAUDE_CODE_USE_VERTEX=1`
- `ANTHROPIC_VERTEX_PROJECT_ID`
- `CLOUD_ML_REGION` or any `VERTEX_REGION_CLAUDE_*` override

`ANTHROPIC_VERTEX_BASE_URL` is reported as an optional gateway/custom endpoint
signal. `CLAUDE_CODE_USE_VERTEX=0|false|no|off` disables Vertex runtime
detection for the HUD, even when project/region variables are inherited.

The read-only CLI surface is:

```bash
claude-ops usage [--json] [--since <date|duration>] [--until <date>] \
  [--session <id>] [--project <path>]
```

It reports local usage history, session/project breakdowns, auth-provider labels,
cache token summaries, and API spend rows from statusLine actual costs plus local
estimates. It deliberately does not claim invoice or quota truth.

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

In API/unknown cost-metered mode, confidence is capped low because quota
windows are absent. API confidence can rise to medium only when local billable
history has matured. In subscription mode, mature sessions without sufficient
history/baselines are capped at medium and should describe themselves as warming
up rather than claiming high confidence.

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

Append-only JSONL at: ~/.claude/plugins/claude-ops/usage-history.jsonl

Each entry:
```json
{
  "schema_version": 4,
  "ts": "2026-04-02T18:30:00Z",
  "session_id": "abc123",
  "five_hour_pct": 62,
  "seven_day_pct": 38,
  "session_burn_rate": 211,
  "context_pct": 48,
  "signal": "nominal",
  "model": "opus",
  "effort": "high",
  "mode": "max",
  "billing_signal": "quota-window",
  "auth_provider": "subscription",
  "project_path": "/work/project",
  "input_tokens": 30000,
  "output_tokens": 9500,
  "cache_create_tokens": 310000,
  "cache_read_tokens": 680000,
  "context_tokens": 72000,
  "context_input_tokens": 30000,
  "context_output_tokens": 9500,
  "context_thinking_tokens": 1500,
  "exceeds_200k_tokens": false,
  "api_calls": 42
}
```

Written every 5 minutes. HUD-written API rows may also include
`session_cost_usd`, `generation_cost_usd`, and `cost_kind`
(`api_statusline_actual` or `api_billable_estimate`). Daemon rows remain
token/burn telemetry and do not masquerade as API billing context.
Used for trend analysis, local API references, and daily digest.

## Integration Points

### HUD Line 8 (Advisor)
Renders the advisory signal as a single colored line.

### Optional: Desktop notification
If signal transitions from nominal → throttle, send via notify-send.

### Optional: Auto-effort
If user opts in, the advisor can write durable effort levels
(`low|medium|high|xhigh`) to settings.json. `max` is session/env-only and
is never persisted.
