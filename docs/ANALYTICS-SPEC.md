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

### Burn rate (session-level)
```
session_tokens = output_tokens + cache_creation_input_tokens
session_duration_min = (now - session_start) / 60
burn_rate = session_tokens / session_duration_min
```

## Advisory Logic

### Decision Matrix

| 5hr Projected | 7day Projected | Session Burn | Recommendation |
|---------------|----------------|--------------|----------------|
| <70%          | <50%           | any          | ▲ INCREASE — safe for high effort + Opus |
| <70%          | 50-80%         | <300t/m      | ▲ INCREASE — safe for high effort |
| <70%          | 50-80%         | >300t/m      | ── NOMINAL — on track |
| 70-90%        | <70%           | <200t/m      | ── NOMINAL — watch 5hr |
| 70-90%        | <70%           | >200t/m      | ▼ REDUCE — 5hr getting tight |
| >90%          | any            | any          | ⚠ THROTTLE — switch to Sonnet or low effort |
| any           | >80%           | any          | ⚠ THROTTLE — weekly budget critical |
| 100%          | any            | any          | ⛔ LIMIT HIT — wait for reset |

### Output Format
```json
{
  "signal": "increase|nominal|reduce|throttle|limit_hit",
  "reason": "38% weekly budget remaining, 62% 5hr used, resets in 2h15m",
  "suggestion": {
    "effort": "high",
    "model": "opus",
    "confidence": 0.85
  },
  "projections": {
    "five_hour_at_reset": 0.78,
    "seven_day_at_reset": 0.52
  }
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
