# HUD Layout Specification

## Design Philosophy

**Every element is always visible.** Nothing disappears.
- Active/loaded → white/bright text
- Inactive/unused → dim gray text
- Warning → yellow
- Critical → red
- Good/healthy → green

## Layout (Vertical Stack, 8 Lines, 80-char minimum)

```
┌──────────────────────────────────────────────────────────────────┐
│ Model   [Opus 4.7 high] project-host git:(main*) ⏱ 23m           │
│ Context ████████░░░░░░ 48% (72K/200K)   in:42K cache:30K          │
│ Usage   5h:████████░░ 62% 2h15m | 7d:████░░░░░░ 38%               │
│ Tokens  in:42K out:9.5K cache:69%  burn:211t/m  18calls           │
│ Env     main:high | sub:sonnet | 13r 7h 2md | UNCOMP              │
│ MCPs    12 loaded │ brave,perplexity,sentry active                │
│ Guard   ✓ 4 saves │ brevity→fixed 2m │ R:E 4.2 (28r/7e) healthy   │
│ Advisor ▲ safe — 38% weekly remaining                             │
└──────────────────────────────────────────────────────────────────┘
```

Line order is fixed. Render order defined in `src/display/renderer.js`
(`LINE_RENDERERS` array). The quality signal (Read:Edit ratio) is merged
into the Guard line — it is not a standalone row.

## Line-by-Line Spec

### Line 1: Model
Always shows: model name + effort badge, project directory, git branch,
session duration. Git dirty indicator in yellow. Effort color: high → green,
medium → yellow, low/default → red.

### Line 2: Context
Progress bar + percentage + token breakdown + (right column) compaction
proximity and peak-context.
- <70%: green bar
- 70-85%: yellow bar
- 85%+: red bar with compaction warning in the right column
Token breakdown (in/cache) always visible.

### Line 3: Usage (Rate Limits)
Both 5-hour and 7-day bars side by side, with reset timers.
- <50%: green
- 50-80%: yellow
- 80%+: red
If no data: dim "5h:--% | 7d:--%".

Bar color is produced by `getQuotaColor(pct)` in
`src/display/colors.js`. Thresholds: GREEN < 50, YELLOW 50–80, RED ≥ 80.

### Line 4: Tokens
in/out tokens, cache hit%, burn rate, API call count.
- Cache hit ≥80%: green; 50–80%: yellow; <50%: red
- Burn rate <200 t/m: green; 200–500: yellow; >500: red
If tracker hasn't run yet: dim placeholders.

### Line 5: Env
main effort, subagent model, rules/hooks/CLAUDE.md counts, compression.
- `main:<effort> | sub:<model> | <counts> | COMP/UNCOMP`
- Compression: COMP in red (quality degraded), UNCOMP in green.
- Effort is sanitized: fallback to settings.json if env value is unknown.
- Counts always in dim: "13r 7h 2md".

### Line 6: MCPs
Total loaded + which ones are actively used this session.
- Connected MCPs in white
- Failed/needs-auth MCPs in red
- Unused but connected in dim
Format: `12 loaded │ brave,perplexity,sentry active`.

### Line 7: Guard + Quality (merged)
Guard status, activation count, last activation, skip indicator,
**and** the real-time R:E quality signal on the same line.

- Guard running, no recent activations: green `✓ quiet`
- Guard running, recent activation: green `✓ 4 saves │ brevity→fixed 2m`
- Guard not running: red `✗ DOWN — run systemctl --user start claude-quality-guard`
- Quality segment: `R:E {ratio} ({reads}r/{edits}e) {status}`
  - ≥ 3.0: green "healthy"
  - 2.0–3.0: yellow "shallow"
  - < 2.0: red "edit-first"
  - No edits yet: dim "R:E --"

Guard log is read from `/tmp/claude-quality-guard.log`. R:E counts
come from transcript tool-use aggregation for the current session.

Critical R:E threshold (< 1.0) only fires as a separate anomaly alert
for Opus models, based on findings from
[anthropics/claude-code#42796](https://github.com/anthropics/claude-code/issues/42796):
good sessions run 6.6+ reads per edit; degraded sessions run ~2.0.

### Line 8: Advisor
Single recommendation synthesised from rate projections and anomaly state.
- Green `▲ safe` — increase effort or use Opus
- Dim `── nominal`
- Yellow `▼ consider reducing — 82% 5hr used`
- Red `⚠ throttle — will hit 5hr limit in 40min`
- Red `⚠ ALERT: <anomaly>` — anomaly alerts override the normal advisor

## Two-Column Layout (≥ 100 chars)

When terminal width is 100+ characters, a secondary column appears to
the right of each line, separated by a dim `│`. The right column shows
complementary data that doesn't fit in the primary display.

| Line    | Right Column                                       |
|---------|----------------------------------------------------|
| Model   | Session duration, cumulative cost, output speed    |
| Context | Peak context this session, context window size    |
| Usage   | Projected % at reset for both windows             |
| Tokens  | Thinking turns, agent spawns, cumulative cost      |
| Env     | Model ID, context window size                      |
| MCPs    | Unused count, failure count from health report     |
| Guard   | Activation rate (per day)                          |
| Advisor | Projected 5h/7d %, burn level (low/med/high)       |

Right column values are dim by default, with color highlights only
when noteworthy (e.g. projected usage > 90% shows red).

The left column is padded to align the separator. Left column width
is capped at 60% of terminal width to ensure the right column has room.

## Narrow Terminal Handling (< 100 chars)

Abbreviate labels:
- "Context" → "Ctx"
- "Tokens" → "Tok"
- "Guard" → "Grd"
- "Advisor" → "Adv"

Truncate MCP names to first 3 chars: `brv,ppl,sen`.
Drop git file stats but keep branch name.

## Color Reference (ANSI)
- White/bright:  `\x1b[1m` (active, loaded, in-use)
- Dim gray:      `\x1b[2m` (inactive, unused, pending)
- Green:         `\x1b[32m` (healthy, under budget)
- Yellow:        `\x1b[33m` (warning, moderate usage)
- Red:           `\x1b[31m` (critical, over budget, error)
- Cyan:          `\x1b[36m` (informational values)
- Reset:         `\x1b[0m`
