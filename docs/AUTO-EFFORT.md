# Effort auto-swap controller

Opus 4.7 exposes durable `effortLevel` rungs — `low`, `medium`, `high`,
and `xhigh` — and Claude Code may also accept `max` as a session/env
override. Claude Ops persists only the durable levels. At xhigh the
per-request token cost can triple. At medium the deep-reasoning budget
shrinks. Neither is universally right: the answer depends on how much
context you've burned and how fast you're burning it. The controller
swaps between `medium`, `high`, and `xhigh` based on live session
metrics.

## Decision ladder

First predicate that fires wins:

| # | Target  | Condition                                                                                 |
|---|---------|-------------------------------------------------------------------------------------------|
| 1 | medium  | `contextPct ≥ 70` OR `burnVelocity ≥ 2.0× P90`                                            |
| 2 | high    | `contextPct ≥ 50` OR `ratio < RE_RATIO_WARN` (read:edit degraded)                         |
| 3 | xhigh   | `contextPct < 30` AND `burnVelocity < 0.5× P50` AND `ratio ≥ RE_RATIO_HEALTHY` AND `conf ≥ med` |
| 4 | —       | otherwise, no change                                                                      |

`burnVelocity` is the session's current burn rate divided by the
user's personal P50 baseline (so `1.0` = typical for this user, not
an absolute). `ratio` is the Read:Edit ratio over the session's
tool calls. `conf` is the advisor engine's self-reported confidence.

## Gates

- **Model:** only Opus 4.7 sessions (`/claude-opus-4-7/i`). Other
  models pass through untouched.
- **Cooldown:** 10 minutes minimum between swaps so a session near
  a boundary doesn't oscillate.
- **Context delta:** at least 5 percentage points of change in
  `contextPct` since the last swap.
- **Opt-in:** the controller is a no-op until
  `~/.claude/plugins/claude-ops/auto-effort.enabled` exists
  (or the `CLAUDE_OPS_AUTO_EFFORT=1` env var is set).

## Files touched

When the controller applies a swap:

1. `~/.claude/settings.json` — updates `effortLevel` atomically for
   `low`, `medium`, `high`, or `xhigh`. `max` is never persisted.
   First write of each day creates a timestamped backup
   (`settings.json.claude-ops.YYYY-MM-DD.bak`) — no backup flood.
2. `~/.claude.json` — updates the cached GrowthBook effort key
   **only if it exists** (so we never pollute a fresh cache).
3. `~/.claude/plugins/claude-ops/effort-log.jsonl` — appends one
   entry per swap (rotated at 1 MB).
4. `~/.claude/plugins/claude-ops/effort-last-swap.json` — the single
   latest swap record, used by the next tick's debounce check.

## Opt in / out

```bash
claude-ops auto-effort on          # or: bash scripts/install-auto-effort.sh
claude-ops auto-effort off
claude-ops auto-effort status      # current state + last 10 swaps
claude-ops auto-effort status --json
```

## HUD surfaces

- **Env line:** the `main:<effort>` value renders **bold** whenever
  the controller is enabled so the user sees the knob is live.
- **Advisor line:** a cyan `· auto:xhigh→medium` trailer appears
  on the exact render that applied the swap. It's absent on every
  other render.

## Known risk

Writing `settings.json` while Claude Code is running is empirically
unverified end-to-end — Claude Code may cache `effortLevel` in
memory per session and pick up the change only on the next session.
If the swap doesn't propagate, the Advisor recommendation is still
the user-facing surface; a session restart picks up the persisted
value.

For one-off `max` sessions, set `CLAUDE_CODE_EFFORT_LEVEL=max` before
launching Claude Code. The HUD will show it as a session override, but
the writer will refuse to store it in `settings.json`.

## Retuning

All thresholds live in `src/advisor/effort-controller.js` as named
constants — `COOLDOWN_MS`, `CONTEXT_DELTA_THRESHOLD`, `RE_RATIO_*`
(imported from `src/anomaly/constants.js`). Changing them and
re-running `npm test` confirms the decision table still matches
the tests in `effort-controller.test.js`.
