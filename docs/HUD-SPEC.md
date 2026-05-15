# HUD Layout Specification

## Design Philosophy

**Every element is always visible.** Nothing disappears.
- Active/loaded → white/bright text
- Inactive/unused → dim gray text
- Warning → yellow
- Critical → red
- Good/healthy → green

## Accuracy Boundary

The HUD is an operator overlay, not Claude Code's source of truth. Some fields
are intentionally approximate:

- Context and compaction proximity are local estimates based on visible
  transcript/token surfaces plus the current reservation heuristic.
- Prompt caching state is split into observed native counters and configured
  cache policy; those signals help explain repeated billing, not exact context
  occupancy.
- Upstream Claude Code banners above the HUD, such as plan-level auto-mode
  warnings, are not rendered or controlled by Claude Ops.

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
Always shows: provider/backend badge, model name + effort badge, project
directory, git branch, session duration. Provider identity is rendered once
here only; Usage and Advisor do not repeat `[ANTHROPIC-*]`, `[VERTEX-AI]`,
`[BEDROCK]`, `[GATEWAY]`, or `[FOUNDRY]` badges. Git dirty indicator in yellow.
Persisted effort levels
are `low`, `medium`, `high`, and `xhigh`; `max` may render only when it
arrives from a session/env override. Effort colour over Opus 4.7:
`high` / `xhigh` / session `max` → green, `low` / `medium` → yellow,
`default` / unknown → red (sentinel meaning "unset"). `xhigh` is the
Claude Code CLI default on Opus 4.7.

### Line 2: Context
Progress bar + percentage + total/window size + compaction proximity.
- <70%: green bar
- 70-85%: yellow bar
- 85%+: red bar with compaction warning in the right column
Cache, native prompt-cache state, and RTK state live on the Tokens line so all
token/cost/cache signals are adjacent instead of split across rows.

### Line 3: Usage (Billing Mode)
Subscription mode renders both 5-hour and 7-day bars side by side, with
reset timers. This mode is used only when Claude Code provides
`rate_limits` in statusLine stdin.
- <50%: green
- 50-80%: yellow
- 80%+: red
If quota data is absent, the line switches to cost-metered mode instead
of rendering placeholder quota rails. API/gateway/Bedrock/Vertex/Foundry
sessions show estimated API billable session cost plus local 5h/7d spend
references. Unknown/offline sessions use the same cost-style surface but
keep confidence low and mark references as missing until history exists.

Provider identity is intentionally absent here; the Model line owns it. Usage
may still show authority markers that describe the measurement source:

- `actual` means statusLine supplied `cost.total_cost_usd`.
- `telem:miss` means Vertex mode is detected but no fresh,
  context-matched provider snapshot is available.
- `metrics` means a Vertex token-metrics snapshot exists but billing/cost
  authority is absent, so advisor confidence remains capped.
- `api` means the Vertex snapshot includes complete cost windows and passed
  freshness plus project/region/model matching checks.

`CLAUDE_CODE_USE_VERTEX=0|false|no|off` is treated as an explicit disable,
even if project/region variables are inherited in the shell.

Bar color is produced by `getQuotaColor(pct)` in
`src/display/colors.js`. Thresholds: GREEN < 50, YELLOW 50–80, RED ≥ 80.

### Line 4: Tokens
in/out tokens, native prompt-cache state, cache hit%, RTK state, burn rate,
API call count.
- Cache hit ≥80%: green; 50–80%: yellow; <50%: red
- Burn rate <200 t/m: green; 200–500: yellow; >500: red
- `native:on`, `native:write`, `native:idle`, and `native:unknown` summarize
  Claude Code native prompt-cache counter state; suffixes such as `1h`, `5m`,
  or `30%5m` summarize observed cache-write TTL split.
- `cfg:off`, `cfg:5m`, and `cfg:1h` report the configured prompt-cache policy
  separately from the observed native cache counters.
- `cache-hist:` means the cache percentage fell back to cumulative history
  because there were not enough recent turns for the rolling window.
- `rtk:saving 42K↓88%`, `rtk:on`, `rtk:stale`, `rtk:off`, and `rtk:disabled`
  report the optional RTK probe state separately from native caching. RTK is
  shown here only; the right column does not repeat RTK command counts.
If tracker hasn't run yet: dim placeholders.

Prompt-cache policy affects repeated billing/reuse, not the logical context
window occupancy. A `cfg:1h` label should not be described as reducing the
headline Context percentage on its own.

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

- Guard audit-only with drift summary: yellow `◌ AUDIT docs:4 drift / int:10 probes / skip:1`
- Guard running, all held: green `✓17/17 │ quiet`
- Guard running with docs-backed drift: red `✗docs:4 drift ○1 skip int:10 probes`
- Guard disabled: red `✗ DISABLED docs:4 drift / int:10 probes — run claude-ops guard mode audit|enforce`
- Guard not running and not audit-only: red `✗ DOWN — run systemctl --user start claude-ops-guard`
- Quality segment: `R:E {ratio} ({reads}r/{edits}e) {status}`
  - ≥ 3.0: green "healthy"
  - 2.0–3.0: yellow "shallow"
  - < 2.0: red "edit-first"
  - No edits yet: dim "R:E --"

Guard log is read from `~/.claude/plugins/claude-ops/guard.log`. Category
state is derived from `claude-ops guard status`: documented/hybrid categories
are separated from internal experimental GrowthBook probes in the drilldown.
The HUD uses documented control drift for red/error posture; internal
GrowthBook-only rows are labelled as probes unless a future pass promotes them
to a documented/hybrid control.
Service posture is explicit: `audit` means installed but inactive, `enforce`
means the guard service is actively running or enabled for startup, and
`disabled` means the guard-disabled flag is set and the service is stopped.
R:E counts come from transcript tool-use aggregation for the current session.

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
- API/Vertex mode does not repeat provider identity or detailed telemetry
  failure text here. Provider identity belongs to Model; Vertex API-cost
  authority belongs to Usage; Advisor carries the action and confidence.
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
once lived in a right column now surfaces via the `claude-ops context` CLI
(2D bucket grid), the drilldown lines inside `claude-ops guard status`,
and the docs-aligned validator inside `claude-ops guard validate`.

Plain/no-color/non-TTY output is a first-class render mode. HUD rows must not
emit ANSI escapes when color support resolves to `none`, and
`CLAUDE_OPS_PLAIN=1` must downgrade gauge, separator, arrow, and status glyphs
to ASCII for logs, CI, and constrained terminals.

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
