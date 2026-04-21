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
┌──────────────────────────────────────────────────────────────────────┐
│ Model   [Opus 4.7 high] project-host git:(main*) ⏱ 23m               │
│ Context ████████░░░░░░ 48% (72K/200K)    │ in:42K cache:30K  ⊕buf:52%│
│ Usage   5h:████████░░ 62% 2h15m │ 7d:████░░░░░░ 38%                  │
│ Tokens  in:42K out:9.5K cache:69%        │ burn:211t/m 18calls ~$0.91│
│ Env     main:high · sub:sonnet │ 13r 7h 2md │ UNCOMP · ⧉2 sessions   │
│ MCPs    12 loaded │ brave,perplexity,sentry active                   │
│ Guard   ✓17/17                           │ ↻4 today (last:brevity 2m)│
│ Advisor 5h ▕██▓─────────────▏ 62→78      │ TTE 6h    │ conf:med  │ ▼ │
│         7d ▕█████▓──────────▏ 38→52      │ TTE 4d12h │ conf:high │ ▲ │
└──────────────────────────────────────────────────────────────────────┘
```

Line order is fixed. Render order defined in `src/display/renderer.js`
(`LINE_RENDERERS` array). The quality signal (Read:Edit ratio) is merged
into the Guard line — it is not a standalone row.

## Visual Grid

Context, Tokens, Guard, and the Advisor rows share a `PRIMARY_COL_WIDTH`
of 32 visual columns, so the first `│` separator stacks vertically
across those lines and the eye tracks a single axis instead of drifting
with per-line content width. Every line uses the dim box-drawing `│`
as its heavy separator; within a semantic group (main+sub on Env,
UNCOMP+sessions on Env) items join with the soft `·` so grouped
fields read as related without adding visual weight.

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
- Trailing `· stale {age}s` (dim) when the analytics daemon hasn't
  refreshed this session's cache in > 2 × poll interval (30 s). Absent
  when the daemon is healthy.

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

### Line 8: Advisor (2 rows, wide mode)
Recommendation synthesised from both rate-window projections and anomaly
state. Wide mode renders as **two aligned rows** — 5h on row 1, 7d on
row 2 — with the gauge / TTE / conf columns padded to fixed visual
widths (32 / 9 / 9) so the `│` separators stack vertically:

```
Advisor 5h ▕██▓─────────────▏ 62→78  │ TTE 6h    │ conf:med  │ ▼ /compact │ ⚡ burn 3× P50
        7d ▕█████▓──────────▏ 38→52  │ TTE 4d12h │ conf:high │ ▲ on track │ △ reversals 27/1k
```

- Row 1 carries the primary (more-pressing) window + action badge + salience segment.
- Row 2 carries the other window + trailing warn badge.
- Narrow mode collapses to a single row (badge + warn only).
- Critical anomalies take over the whole line (single row, red).
- Green `▲ safe` — increase effort or use Opus
- Dim `── nominal`
- Yellow `▼ consider reducing — 82% 5hr used`
- Red `⚠ throttle — will hit 5hr limit in 40min`
- Red `⚠ <anomaly>` — critical anomalies override the normal advisor
  (terse: `{metric} {value} — {diagnosis}`, ≤ 48 visible chars, no `ALERT:` prefix)
- Dim `~ on track — warming up` — low confidence + tier=ok (engine hasn't
  seen enough data yet; badge never rendered at full green until `conf:med`)
- Trailing salience segment (wide only, one at most, priority order):
  - `⚡ burn {x}× P50` when burn velocity ≥ 2× personal P50
  - `◆ peak {n}%` when peak-hour share ≥ 60%
  - `◐ R:E {r}` when ratio below WARN and edits ≥ RE_MIN
  Omitted when no baseline exists (never a placeholder).
- Warn-level anomalies ride as a trailing `△ {message}` badge — the
  main advisor content stays visible. Reasoning-reversals ≥ 25/1k tool
  calls fires through this channel.

## Single-Column Layout

The HUD renders as eight single-line rows regardless of terminal width.
Lines wider than the terminal wrap at separator boundaries (see
`wrapLineToWidth` in `src/display/text.js`). A prior two-column layout was
removed after it proved brittle in the Claude Code statusLine subprocess
environment (no TTY, unreliable width detection) — the breakdown data that
once lived in a right column now surfaces via the `setpoint context` CLI
(2D bucket grid) and the drilldown lines inside `setpoint guard status`.

## Narrow Terminal Handling (< 100 chars)

Abbreviate labels:
- "Context" → "Ctx"
- "Tokens" → "Tok"
- "Guard" → "Grd"
- "Advisor" → "Adv"

Truncate MCP names to first 3 chars: `brv,ppl,sen`.
Drop git file stats but keep branch name.

Guard line narrow-mode fallback: the 17-char revert-frequency ribbon
collapses to a single glyph (`▲` in the last-reverted category's shade)
so the heatmap signal is still visible below 100 cols. R:E badge drops
the `(28r/7e) healthy` tail and keeps colored `R:E 4.2`.

## Color Reference (ANSI)
- White/bright:  `\x1b[1m` (active, loaded, in-use)
- Dim gray:      `\x1b[2m` (inactive, unused, pending)
- Green:         `\x1b[32m` (healthy, under budget)
- Yellow:        `\x1b[33m` (warning, moderate usage)
- Red:           `\x1b[31m` (critical, over budget, error)
- Cyan:          `\x1b[36m` (informational values)
- Reset:         `\x1b[0m`
