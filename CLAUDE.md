# setpoint — Control Loop for Claude Code

## What this is
A control loop for Claude Code CLI. The guard holds seventeen `tengu_*` GrowthBook feature flags at their configured setpoints whenever Anthropic's service reverts them. Around that control loop sit five observability subsystems — a statusLine HUD, analytics daemon, anomaly detector, health auditor, and daily advisor — all reading and writing shared per-session state.

> On-disk data path is `~/.claude/plugins/claude-hud/` (legacy slug preserved; the product name is `setpoint`). Repo directory and systemd unit names are similarly preserved so existing installs don't break.

## Subsystems

### 1. Display engine (`src/display/`)
The visible terminal HUD. 8+ always-visible vertically-stacked lines.
- **Design rule**: Nothing ever disappears. White = active/loaded. Dim gray = inactive/unused.
- **Narrow terminal**: Abbreviate labels at <100 chars width.
- See `docs/HUD-SPEC.md` for exact line-by-line layout.

**Lines:**
```
 Model    [Opus 4.7] project-host git:(main*) ⏱ 23m
 Context  ████████░░░░░ 48% (42K/200K) compact:52%
 Usage    5h:██████░░░░ 62% 2h15m | 7d:████░░░░░░ 38%
 Tokens   in:42K out:9.5K cache:69% burn:211t/m 18calls
 MCPs     12 loaded | 3 active: brave,perplexity,sentry
 Env      effort:high | 13r 7h 2md | UNCOMP
 Guard    ✓ active | 4 saves today | last: brevity→fixed 2m ago
 Advisor  ▲ safe — 38% weekly remaining, increase effort ok
```

**Additional display features:**
- Compression indicator: shows `COMP` (red) when tengu_summarize_tool_results=true, `UNCOMP` (green) when false
- Active tool timer: when a tool call is running, show elapsed seconds
- Session cost estimate: cumulative token cost at API-equivalent pricing

### 2. Quality guard (`src/guard/`)
Watches ~/.claude.json via inotify (Linux). Re-applies quality overrides within
~5ms (Rust impl) or ~100ms (bash fallback) of any GrowthBook revert. Runs as a
systemd user service. The Rust core at `src/guard/rust/` is the primary impl
built by `scripts/build-guard.sh`; the bash script at
`src/guard/claude-quality-guard.sh` is the fallback used when cargo is missing.

**Default state: DISABLED.** The guard is installed but does not run until explicitly
started. This prevents unintended interference with Claude Code's normal operation.
To enable: `systemctl --user start claude-quality-guard` or remove the disabled flag
at `~/.claude/plugins/claude-hud/guard-disabled`.

**Overrides enforced (17 categories, all ON by default):**

| Category | Flag(s) | Target Value |
|----------|---------|-------------|
| brevity | `tengu_swann_brevity` | `""` (prevents "focused" brevity) |
| quiet | `tengu_sotto_voce`, `quiet_fern`, `quiet_hollow` | `false` |
| summarize | `tengu_summarize_tool_results` | `false` (critical — prevents tool output compression) |
| maxtokens | `tengu_amber_wren.maxTokens` | `128000` |
| truncation | `tengu_pewter_kestrel.*` (all per-tool subkeys — `global`, `Bash`, `PowerShell`, `Grep`, `Snip`, `StrReplaceBasedEditTool`, `BashSearchTool`) | `500000` |
| refresh_ttl | `tengu_willow_refresh_ttl_hours` + `tengu_willow_census_ttl_hours` (the former was the live key pre-Apr 2026; both are set for forward compat) | `8760` (1 year) |
| mcp_connect | `tengu_claudeai_mcp_connectors` | `false` |
| bridge | `bridge.enabled` | `false` |
| grey_step | `tengu_grey_step` | `false` (effort reducer v1) |
| grey_step2 | `tengu_grey_step2.enabled` | `false` (medium effort override) |
| grey_wool | `tengu_grey_wool` | `false` (effort reducer v3) |
| thinking | `tengu_crystal_beam.budgetTokens` | `128000` (Opus 4.6 and earlier only — auto-skipped on fresh install because Opus 4.7 rejects `thinking.budget_tokens` with a 400. Re-enable with `setpoint-guard unskip thinking` on Opus 4.6.) |
| willow_mode | `tengu_willow_mode` | `""` (disables "hint" downgrade) |
| compact_max | `tengu_sm_compact_config.maxTokens` | `200000` |
| compact_init | `tengu_sm_config.minimumMessageTokensToInit` | `500000` |
| tool_persist | `tengu_tool_result_persistence` | `true` |
| chomp | `tengu_chomp_inflection` | `true` (adaptive processing) |

**Configurability:**
Run `setpoint-guard config` (or the bash fallback's `claude-quality-guard.sh config`)
to see all categories with `[ON]`/`[OFF]` status.
Disable a category: `setpoint-guard skip <category>`
Re-enable: `setpoint-guard unskip <category>`
Restore defaults: `setpoint-guard reset`
Inspect live drift: `setpoint guard status` (Node CLI, reads the same state).

**Metrics exposed to display:**
- Activation count (today / this session)
- Time since last activation
- Which specific flag was reverted (most recent)
- Service uptime / health status
- GrowthBook revert frequency (activations per hour)

### 3. Analytics engine (`src/analytics/`)
Computes rolling usage rates, budget projections, and consumption patterns.
See `docs/ANALYTICS-SPEC.md` for calculation details.

**Metrics:**
- 5-hour rolling rate: tokens consumed per minute, projected exhaustion time
- 7-day rolling rate: average daily consumption, projected at reset
- Per-project burn tracking: accumulated tokens per project directory
- Cache efficiency trend: hit% over time, degradation alerts
- Compaction frequency: how often auto-compact fires per session
- Burn rate: tokens/minute with color coding (green/yellow/red)
- Session cost estimate: output + cache_create tokens at API pricing

### 4. Health auditor (`src/health/`)
Periodic scanner for ~/.claude/ directory and MCP configuration health.
Runs daily (cron or systemd timer) and on-demand.

**Checks:**
- Session JONL bloat: flag projects with >50MB of session files
- Orphan file detection: files/dirs in ~/.claude/ that shouldn't be there
- Plugin cache staleness: outdated versions vs installed
- MCP health probe: connection test + latency for each configured MCP
- MCP usage audit: flag MCPs not invoked in >7 days (context waste candidates)
- Config drift detection: snapshot ~/.claude.json + settings.json, alert on
  unexpected changes not from user or guard (catches rogue agent modifications)
- CLAUDE.md accumulation check: total token cost of all CLAUDE.md files in
  the walk-up chain for active projects. Flag new upstream additions.
- Disk usage summary: ~/.claude/ total size, projects/ breakdown, recommendations

**Output:** JSON report at ~/.claude/plugins/claude-hud/health-report.json
Display engine reads and surfaces issues on the HUD.

### 5. Daily advisor (`src/advisor/`)
Runs daily while `daily-advisor.timer` is loaded (wall-clock `OnBootSec=1d` +
`OnUnitActiveSec=1d`), or on-demand. Produces actionable recommendations
based on accumulated data.

**Analyses:**
- Usage efficiency score: ratio of productive output (files written, tools used)
  to total tokens consumed. Identifies wasteful sessions.
- Top token consumers: which sessions, projects, agent spawns burned the most.
  "startup-team design agent: 152K cache_create in one meeting transcript"
- Effort/model matrix: based on trailing week, recommend optimal effort level
  and model. "38% 7-day budget used with 6 days remaining → safe for Opus high"
- Peak usage heatmap: which hours of day you're most active. If 5hr window resets
  at a bad time relative to peak, suggest shifting heavy sessions.
- Configuration recommendations: based on health audit + usage patterns, suggest
  MCP pruning, rule consolidation, session length adjustments.
- Weekly trend report: consumption trajectory, are you using more or less than
  last week? Is efficiency improving?

**Output:** Markdown report at ~/.claude/plugins/claude-hud/daily-report.md
Also surfaces one-line summary on the HUD Advisor line.

**On-demand drilldown:** `setpoint advisor status [--json]` renders the
current `Recommendation` (tier, signal, action, confidence), the live
metrics block (burnVelocity, reads/edits/ratio, peakActive, TTE), the
personal P50/P90/P10 baselines, the peak/off-peak burn split, the
session's reversals-per-1k rate, and the tail of the most recent
`daily-report.md`. Use it when the one-line HUD summary isn't enough
and you don't want to wait for the next timer run. Parallels
`setpoint guard status`.

The HUD Advisor line also carries a trailing salience segment — the
single most-anomalous metric for the current session (`⚡ burn x× P50`,
`◆ peak n%`, or `◐ R:E r`) — and a warn badge when reasoning reversals
exceed 25/1k tool calls. Both are silent when no baseline is available,
never rendered as placeholders.

### 6. Anomaly detector (`src/anomaly/`)
Real-time alerting for unusual patterns. Runs continuously alongside display engine.

**Alerts:**
- Token spike: single turn consumes >50K tokens (configurable threshold).
  Surfaces immediately on HUD. Common cause: massive file reads, agent loops.
- Runaway agent: agent spawn count exceeds threshold in time window.
  Catches recursive sub-agent spawning (IceCrown failure mode).
- Context thrashing: compaction fires >N times in a session. Indicates session
  is too long or context is being wasted. Recommend /clear or restart.
- MCP failure streak: same MCP fails 3+ times consecutively. Suggest disabling.
- Reasoning reversals: assistant output contains >25 retraction phrases
  ("wait,", "actually,", "let me fix") per 1000 tool calls. Suggests the
  model is thrashing instead of converging. Rides the Advisor line as a
  trailing warn badge.
- GrowthBook escalation: guard activations spike (>20/hour). Indicates Anthropic
  changed sync frequency — user should be aware.
- Config tampering: ~/.claude.json modified by process other than guard or user.
  Catches rogue agent configuration changes.
- Unusual session pattern: session duration >4hrs without compaction or manual
  /clear. Likely degraded context quality.

**Notification:** Display on HUD (alert line replaces advisor when active).
Optional: desktop notification via notify-send for critical alerts.

## Data layer (`src/data/`)

### Sources (read-only)
- stdin JSON: piped by Claude Code to HUD process (real-time)
- Session JONLs: ~/.claude/projects/{slug}/{session}.jsonl (polled 15s)
- ~/.claude.json: config + cached GrowthBook features (watched by guard)
- /tmp/claude-quality-guard.log: guard activity timestamps

### Storage (write)
- usage-history.jsonl: append-only, one entry per 5 minutes with all metrics.
  Located at ~/.claude/plugins/claude-hud/usage-history.jsonl
- health-report.json: latest health audit results (overwritten daily)
- daily-report.md: latest daily advisory (overwritten daily)
- anomaly-log.jsonl: append-only log of all triggered anomaly alerts

## Architecture

```
Claude Code ──stdin──→ Display engine (renders 8 lines)
                          ↑ reads
                    Analytics engine ←── Session JONLs (polled 15s)
                          ↑ reads
                    usage-history.jsonl ←── Analytics engine (writes every 5m)
                          ↑ reads
                    Daily advisor (runs every 24h active usage)
                    
~/.claude.json ──inotify──→ Quality guard (Rust: <5ms; bash fallback: ~100ms)
                               ↑ logs to
                          /tmp/claude-quality-guard.log
                               ↑ reads
                          Display engine (guard status line)
                          Anomaly detector (revert frequency)

Health auditor ──cron/timer──→ health-report.json
                                  ↑ reads
                               Display engine (surfaces issues)
                               Daily advisor (includes in report)

Anomaly detector ──continuous──→ anomaly-log.jsonl
                                    ↑ alerts
                                 Display engine (alert line)
                                 notify-send (optional desktop alert)
```

## Tech stack
- Node.js ESM (no TypeScript compile step — JSDoc types for IDE)
- Zero npm dependencies (Node stdlib only)
- Optional: better-sqlite3 if JSONL becomes insufficient (future)
- systemd user services for guard and health auditor

## Integration
Replaces any existing HUD installation. Run `bash scripts/migrate.sh`
to update the Claude Code statusLine config.

## Related services
- Guard service: `~/.config/systemd/user/claude-quality-guard.service`
- Analytics daemon: `~/.config/systemd/user/claude-hud-analytics.service`
- Health timer: `~/.config/systemd/user/claude-hud-health.timer`
