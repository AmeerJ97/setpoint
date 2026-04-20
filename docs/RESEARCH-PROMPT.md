# Gemini Research Prompt — Setpoint HUD v2

> Paste everything below (between the `---` markers) into Google Gemini (Deep Research mode preferred). It is a self-contained research brief with full project context, the exact questions we need answered, and the deliverable format.

---

# Research Brief: Designing a Sophisticated Control-Loop HUD for Claude Code

## 1. What I'm building and why I need this research

I maintain **`setpoint`** — a terminal status-line HUD + control loop for Anthropic's **Claude Code CLI**. It does four things in one process family:

1. **Renders an always-on 8-line HUD** above the Claude Code input area (`statusLine` plugin).
2. **Guards 17 `tengu_*` GrowthBook feature flags** at specific values by watching `~/.claude.json` with `inotifywait` and re-applying reverts in <500 ms.
3. **Analyzes usage** (5-hour and 7-day rolling rate limits, burn rate, cache efficiency, compaction frequency, Read:Edit tool ratio, etc.).
4. **Produces advice and anomaly alerts** (throttle / nominal / increase-effort, token spikes, runaway agents, context thrashing, Opus R:E < 1.0, etc.).

The current HUD works but is naive: it mostly surfaces raw telemetry, the advisor logic is a hand-coded decision matrix, the anomaly rules are static thresholds, and the design of "what actually deserves a line" was guessed rather than researched. I want to rebuild it to be **dramatically more well-informed, intelligent, and sophisticated**.

Your job is to research everything I list in §5 and return a structured report in the format in §7. I'll use that report as the authoritative input when I redesign the HUD, advisor, guard, and anomaly engine.

## 2. Ground truth on Claude Code internals (do not assume — verify)

Some facts I already know (please verify and deepen, not restate):

- Claude Code is an Anthropic-maintained CLI. It supports Opus / Sonnet / Haiku families, with `effortLevel` (low / medium / high) that maps to a thinking-token budget.
- It uses **GrowthBook** for feature-flagging. A cache of resolved features is written to `~/.claude.json` under `oauthAccount`/`cachedStatsigGates`/`featureFlags`/similar keys. The same file also stores `statsigStableID`, rate-limit usage counters, and recent conversation metadata. When Claude Code refreshes features from the GrowthBook API, previously-overridden values revert to server defaults — that's what the guard exists to undo.
- The status-line plugin protocol: Claude Code spawns the configured `statusLine.command` once per render cycle, pipes a JSON blob to stdin containing model info, `session_id`, `transcript_path`, `context_window` (`context_window_size`, `used_percentage`, `current_usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`), and `rate_limits.{five_hour, seven_day}.{used_percentage, resets_at}`. The plugin writes lines to stdout, which Claude Code draws above the prompt.
- Session transcripts are written to `~/.claude/projects/<slug>/<session-id>.jsonl` — newline-delimited JSON per turn, containing message text, tool calls, token usage, model, and timestamps.
- **Known GrowthBook flags the guard currently pins** (name → value → why):
  - `tengu_swann_brevity` → `""` (prevents "focused" brevity downgrade)
  - `tengu_sotto_voce`, `quiet_fern`, `quiet_hollow` → `false` (disable quiet modes that swallow tool output)
  - `tengu_summarize_tool_results` → `false` (single most impactful quality flag; when true, tool outputs are compressed before the model sees them)
  - `tengu_amber_wren.maxTokens` → `128000` (per-response max output)
  - `tengu_pewter_kestrel.global` → `500000` (tool output truncation cap)
  - `tengu_willow_refresh_ttl_hours` → `8760` (push feature refresh to once a year)
  - `tengu_claudeai_mcp_connectors` → `false` (disables cloud MCP connectors)
  - `bridge.enabled` → `false`
  - `tengu_grey_step`, `tengu_grey_step2.enabled`, `tengu_grey_wool` → `false` (three effort-reducer variants)
  - `tengu_crystal_beam.budgetTokens` → `128000` (thinking budget)
  - `tengu_willow_mode` → `""` (disables a capability-downgrade "hint" path)
  - `tengu_sm_compact_config.maxTokens` → `200000` (compaction-survival cap)
  - `tengu_sm_config.minimumMessageTokensToInit` → `500000` (compaction trigger)
  - `tengu_tool_result_persistence` → `true` (preserve tool results across compaction)
  - `tengu_chomp_inflection` → `true` (adaptive processing)
- Relevant open issues: `anthropics/claude-code#41477`, `#42796` (R:E-ratio evidence of degraded Opus sessions), `#28941`.

If any of the above is wrong, out of date, or has a known nuance I'm missing — correct me explicitly in your report.

## 3. Current HUD (v1) — what it looks like today

Eight fixed lines, always visible, color-coded (white = active, dim = inactive, green/yellow/red for thresholds), with an optional right column at ≥100 chars width:

```
 Model    [Opus 4.7 high] project-name git:(main*) ⏱ 23m
 Context  ████████░░░░░ 48% (72K/200K)  in:42K cache:30K
 Usage    5h:████████░░ 62% 2h15m │ 7d:████░░░░░░ 38%
 Tokens   in:42K out:9.5K cache:69%  burn:211t/m  18calls
 Env      main:high │ sub:sonnet │ 13r 7h 2md │ UNCOMP
 MCPs     12 loaded │ brave,perplexity,sentry active
 Guard    ✓ 4 saves │ brevity→fixed 2m │ R:E 4.2 (28r/7e) healthy
 Advisor  ▲ safe — 38% weekly remaining
```

Known weaknesses I want this research to resolve:

- Information density is low — 8 fixed lines at ~80 chars is ~640 chars of real estate, and most of it is labels, not signal.
- The advisor line is single-shot text; it doesn't convey trend, confidence, or what-to-do-next with any granularity.
- Anomaly rules are static thresholds (e.g., "output > 50K in one turn = spike"). No baselining, no learning, no per-project calibration.
- Guard status is binary ("running / DOWN") plus a last-activation blurb. Doesn't reflect drift severity, per-category health, or whether the *cached* value is currently correct — only whether the guard has fired recently.
- No rendering of what `COMP`/`UNCOMP` actually *means* for this turn's tool output — it's a flag, not a felt effect.
- "Env" line ("13r 7h 2md") is opaque to anyone but me.
- No visualization of cost, no visualization of cache-creation spend vs savings, no visualization of sub-agent fan-out, no visualization of per-tool latency.
- No concept of "session phase" (plan vs implement vs verify) — every phase looks the same.

## 4. Subsystems (what each currently does, and the kind of intelligence each needs)

### 4.1 Guard (`src/guard/claude-quality-guard.sh`, bash + python one-shot)

- Watches `~/.claude.json` with `inotifywait`. On any write, re-applies the 17-category override set in a single Python pass.
- Runs as a disabled-by-default systemd user service (`claude-quality-guard.service`).
- Per-category skip files at `~/.claude/plugins/claude-hud/guard-config/<cat>.skip`.
- Logs every activation to `/tmp/claude-quality-guard.log`.
- CLI: `setpoint guard status [--json]` prints held/drift/skipped per category.

### 4.2 Analytics (`src/analytics/`, node ESM daemon polling every 60 s)

- Reads session JSONLs, computes burn rate, cache efficiency, input/output/cache tokens, tool call counts, thinking turns, agent spawns, compaction events.
- Writes `~/.claude/plugins/claude-hud/token-stats/<session_id>.json` (per-session cache) and appends to `usage-history.jsonl` every 5 min.
- `rates.js` does the 5h/7d projection math (linear extrapolation from elapsed window fraction).

### 4.3 Anomaly detector (`src/anomaly/`)

- Eleven rules executed inline per render: token spike, runaway agent, context thrashing, stale session, GrowthBook escalation, background-process drain (Cowork / CCD / chrome-native-host), context pressure (>85%), MCP failure streak, Opus R:E < 1.0, session efficiency, tool diversity.
- All alerts appended to `anomaly-log.jsonl`. Critical alerts replace the advisor line.

### 4.4 Health auditor (`src/health/`, daily systemd timer)

- Session JSONL bloat (>50 MB/project), orphan files, plugin cache staleness, MCP latency probe, MCP-unused-in-7-days, config drift snapshot, CLAUDE.md token-cost accumulation, disk usage summary.
- Writes `health-report.json`; HUD reads summary on Line 6.

### 4.5 Advisor (`src/advisor/`, daily + on-demand)

- Analyses: `efficiency.js`, `top-consumers.js`, `effort-matrix.js`, `weekly-trend.js`, `rtk-efficiency.js`.
- Writes `daily-report.md`; HUD Line 8 surfaces a one-line summary.
- Current advice is a 9-row decision matrix over (5h projected, 7d projected, burn rate).

### 4.6 Renderer (`src/display/` + `src/hud/renderer.js`)

- Node ESM, zero npm deps. Eight line renderers in `src/display/lines/*.js`. Right-column renderer. Gradient/palette system in `colors.js`. Nerd-font/ASCII-plain fallbacks.

## 5. Research questions — please answer all of these

Organize your final report around these sections. Depth matters more than breadth — I'd rather have 6 well-sourced paragraphs than 30 bullet points.

### 5.1 Claude Code internals (authoritative)

- Enumerate every documented and reverse-engineered **`tengu_*` GrowthBook flag** you can find, with: canonical name, observed value type, observed default, what it actually controls, and which Claude Code commit / release introduced or changed it. Scan the `anthropics/claude-code` GitHub repo, issues, discussions, Reddit (`r/ClaudeAI`, `r/ClaudeCode`), HackerNews threads, and independent writeups. For each, say whether `setpoint`'s current target value in §2 is correct, suboptimal, outdated, or dangerous.
- Document the **exact schema** of the status-line stdin JSON (all known fields, not just the ones in §2). Include fields that only appear under certain conditions (Opus vs Sonnet, compacted vs fresh session, rate-limited vs not, Cowork enabled, etc.).
- Document the **exact schema** of session transcript JSONLs: all message types, tool-call shapes, token-usage shapes, how agent spawns are serialized, how compaction events appear, how Cowork / CCD background processes leave traces.
- Explain how `effortLevel` is interpreted at runtime — does it map to a thinking-token budget? Does it interact with `tengu_crystal_beam.budgetTokens`? Does Claude Code silently downgrade effort in-session (the `grey_step` / `willow_mode` pathways)? What are the observable signals that a silent downgrade happened?
- What's the actual cost model? Confirm current per-MTok prices for Opus 4.7, Sonnet 4.6, Haiku 4.5, and their cache-read vs cache-write rates. Confirm whether thinking tokens count toward output cost or separately. Cite Anthropic pricing pages with dates.
- What's the 5-hour rate-limit mechanic in detail — is it a sliding window or a fixed bucket? Is it per-model, per-account, or shared? How does the 7-day window interact? How does Max vs Pro vs Team affect both?

### 5.2 Observability & control-loop design (what a sophisticated HUD would show)

- Research **terminal HUD / TUI design** — what do best-in-class observability UIs (htop, btop, k9s, lazygit, glances, nvtop, bpftop, zellij status bars, fastfetch, gpustat, ccusage, ccstatusline, CCometixLine) do that `setpoint` v1 doesn't? Be specific about *what information is shown* and *how it's encoded*, not just "it looks pretty."
- What's the right density-vs-signal tradeoff for an **always-on 8-line HUD that renders above a TTY prompt**? Eye-tracking / usability research welcomed.
- For each of the 8 current lines, critique: (a) is this line carrying its weight? (b) what's a strictly-better information payload for this line? (c) is there a completely different line that would be more valuable?
- Propose **at least 3 alternative layouts**: one optimized for a tiled WM power user (wide terminals), one for laptop-only / narrow terminals, and one for the "I only glance at it" casual user. Include ASCII mockups.
- What **glyphs, sparklines, gauges, and micro-visualizations** can you fit in 1–2 terminal cells that convey trend (direction + magnitude + confidence)? Show real ASCII/Unicode examples, not theory.
- Should the HUD have a **per-line priority / suppression system** (e.g., if nothing is anomalous, the anomaly line goes dim; if everything is nominal, the advisor line collapses)? Argue for or against, citing observability-UI literature.
- Research **"flow state" / coding-session" telemetry**: are there established signals (keystroke cadence, tool-call cadence, idle gaps, context-pressure curves) that predict session productivity? Cite any academic or industry work.

### 5.3 Advisor intelligence (replace the 9-row decision matrix with something real)

- Research **budget-management algorithms** applicable to a dual-window rate limit (5 h + 7 d) with a known reset time. What does the optimal-stopping / bandit / constrained-MDP literature say? Is there a clean closed-form "safe spend rate" that beats linear extrapolation?
- What's the right way to fuse multiple signals (5h projection, 7d projection, burn rate, cache efficiency, R:E ratio, compaction frequency, session duration, model, effort) into a **single actionable recommendation**? Weighted score? Rule-based expert system with confidence? Learned model? Be specific about tradeoffs.
- How do **ccusage**, **Claude-Code-Usage-Monitor**, **Cometix**, **ccstatusline**, and any paid tools (Granola-style usage dashboards, LangSmith, Helicone, PostHog-for-LLMs) project and advise? What do they do better than `setpoint`? What do they get wrong?
- What's the right **"session cost"** metric to display — raw API-equivalent $, opportunity cost (% of weekly budget), time-to-exhaustion? What do power users actually act on?
- What **confidence / uncertainty** should be attached to every projection? A 5 h window with only 10 min elapsed has noisy linear extrapolation; how should the HUD communicate that the number is not yet trustworthy?
- When should the advisor recommend **model swap** (Opus → Sonnet) vs **effort downgrade** vs **hard stop** vs **/clear** vs **restart-session**? What does the evidence say about which of these is most effective for reclaiming a degraded session?
- Research the **Read:Edit ratio** finding in `#42796` (good sessions = 6.6 r/e, degraded = 2.0). Does independent evidence support it? Are there other tool-mix signals (e.g., Grep:Glob:Read ratios, tool diversity index, tool-cadence jitter) that correlate with session quality?

### 5.4 Guard enforcement (what a sophisticated guard shows)

- For each of the 17 guarded categories, give me a **failure-mode table**: what does the user experience if this flag is reverted and not caught? (e.g., "summarize=true → tool output compressed → model hallucinates filenames"). Cite real user reports where possible.
- Is there evidence of **other `tengu_*` flags** currently unguarded that should be? Especially anything added in Claude Code releases since 2026-02.
- What's the right way to display **per-category guard health** in a single HUD line? Today it's "✓ 4 saves │ brevity→fixed 2m". Propose denser encodings (e.g., a 17-glyph ribbon where each glyph reflects one category's drift state).
- Should the guard also watch `~/.claude/settings.json`, `~/.config/claude-code/`, or anywhere else for related drift? Are there non-GrowthBook settings that cause quality regressions?
- How do real-world control loops handle **revert storms** (GrowthBook refreshing 5 × per minute)? When should the HUD escalate from "guard quietly fixing" to "user needs to act"?
- What's a sensible **SLA** for guard latency (<500 ms today)? Is there evidence that lag matters?

### 5.5 Anomaly detection (replace static thresholds)

- For each of the 11 existing rules, critique the threshold: is 50K tokens the right "token spike" cutoff? Is "4 hours without compaction" a real signal or a guess?
- Propose **per-project / per-user baselining**: EWMA, MAD-based outlier detection, seasonality-aware thresholds. Be concrete — give me pseudocode or at least the algorithm name + parameters.
- Research known **Claude Code pathologies** from GitHub issues and Reddit — sub-agent runaway loops, Cowork background drain, chrome-native-host bleed, Desktop-app double-billing, cache invalidation on model swap, MCP thrash on restart. Map each to a detectable signal.
- What's the right **alert fatigue** policy? When the advisor line is hijacked by an anomaly, what's the escalation ladder (dim → yellow → red → desktop notification → session pause)?
- Is there prior art for **log-based anomaly detection in dev tools** (git bash, shell, IDE telemetry) that we should copy?

### 5.6 Ecosystem & positioning

- Deep-dive comparison of `setpoint` vs: ryoppippi/ccusage, sirmalloc/ccstatusline, Maciek-roboblog/Claude-Code-Usage-Monitor, Haleclipse/CCometixLine, and any newer tools launched 2026-01 → 2026-04. For each: feature matrix, design philosophy, what they do that `setpoint` should adopt, what `setpoint` already does better.
- Are there **Anthropic-official** tooling directions we should watch? A status-line API change, an official analytics dashboard, an official guard-like mechanism? Cite release notes, blog posts, and staff Twitter/X.
- Are there **closed-source / paid** tools (Cursor-specific, Windsurf-specific, GitHub Copilot-specific) that solve the same telemetry problem for non-Claude-Code editors, and what can we learn from their UX?

### 5.7 Implementation-level technical questions

- What's the cheapest way to **poll session JSONLs** for <100 ms render latency in a Node.js plugin that's re-spawned on every render? Is `fs.watch`, `chokidar`, inotify, a long-running sidecar, or a shared-memory cache the right answer?
- What Node.js **terminal-rendering libraries** would cut our custom gradient/palette code without bloating the bundle (we're currently zero-dep)? Evaluate: `chalk`, `picocolors`, `kleur`, `cli-color`, `ansi-escapes`, `log-update`, `blessed`, `ink`, `neo-blessed`, `tty-table`.
- Is the **zero-dependency constraint** still the right call in 2026? What do we gain vs what we give up?
- Should the guard be rewritten in a real language (Rust? Go?) to get <50 ms latency and drop the bash+python coupling? Show me real benchmarks from similar tools.
- What's the right storage layer for 7+ days of history? JSONL today — when does SQLite (or DuckDB, or sqlite-vec) start paying off?
- Is there a cleaner pattern for the "one-shot render command + long-running daemon + guard service + daily timer" four-process topology? Would a single long-running daemon with a thin render client be better? What do other TUI ecosystems do?

### 5.8 Open questions I haven't thought to ask

End your report with a section of **"questions AJ didn't ask but should've"** — things a sophisticated observer of this project would flag that I missed. Be blunt. If my whole line-based HUD metaphor is wrong, say so.

## 6. Research rules

- **Cite everything.** GitHub permalinks (pinned to a commit, not `main`), Anthropic docs URLs with dates, issue numbers, commit SHAs, Reddit thread URLs, timestamps. If you can't cite it, say "uncited claim" explicitly.
- **Verify before asserting.** When you state a flag's behavior, show the code/issue/docs link that proves it. When you state pricing, show the Anthropic pricing-page URL with capture date.
- **Prefer primary sources.** Anthropic's own docs and the `anthropics/claude-code` repo beat third-party blog posts. Third-party blog posts beat StackOverflow answers. StackOverflow beats Twitter.
- **Flag uncertainty explicitly.** If something was true as of 2025 but may have changed — say so. If you're speculating, prefix with "speculation:".
- **Be concrete.** "You should improve the advisor" is useless. "Replace the 9-row matrix with a 3-feature logistic regression trained on `usage-history.jsonl`, initialized with the weights in §X" is useful.
- **Respect the existing architecture when giving implementation advice.** Node ESM, zero deps, one-shot renderer, systemd-user services, JSONL storage, bash+python guard. Suggest rewrites only when the payoff is large and you show the math.
- **No fluff.** No "I hope this helps!", no executive summary of what you're about to say. Just the report.

## 7. Deliverable format

A single Markdown document with this exact section hierarchy:

```
# Setpoint HUD v2 — Research Report

## 0. Corrections to the brief
(anything in §2 / §3 / §4 of this prompt that's wrong or out of date)

## 1. Claude Code internals
### 1.1 tengu_* flag catalog
### 1.2 Stdin JSON schema (full)
### 1.3 Transcript JSONL schema (full)
### 1.4 Effort / thinking / model mechanics
### 1.5 Pricing & cost accounting
### 1.6 Rate-limit mechanics

## 2. HUD design
### 2.1 Best-in-class TUI reference set
### 2.2 Per-line critique of setpoint v1
### 2.3 Three proposed layouts (with ASCII mockups)
### 2.4 Micro-visualization vocabulary
### 2.5 Priority / suppression strategy
### 2.6 Flow-state telemetry literature

## 3. Advisor intelligence
### 3.1 Budget-management algorithms
### 3.2 Signal-fusion approaches
### 3.3 Competitor advisor comparison
### 3.4 Cost metric recommendation
### 3.5 Confidence / uncertainty display
### 3.6 Action ladder (swap / downgrade / stop / /clear / restart)
### 3.7 R:E ratio and other quality signals

## 4. Guard enforcement
### 4.1 Per-flag failure-mode table
### 4.2 New flags to add to the guard
### 4.3 Dense per-category display encoding
### 4.4 Additional config surfaces to watch
### 4.5 Revert-storm escalation policy
### 4.6 Latency SLA recommendation

## 5. Anomaly detection
### 5.1 Threshold critique per existing rule
### 5.2 Baselining algorithm recommendation
### 5.3 Claude Code pathology catalog + detectable signals
### 5.4 Alert-fatigue policy
### 5.5 Prior art from dev-tool telemetry

## 6. Ecosystem & positioning
### 6.1 Tool-by-tool comparison matrix
### 6.2 Anthropic-official directions to track
### 6.3 Lessons from paid / closed-source tools

## 7. Implementation-level technical decisions
### 7.1 Fast polling / caching
### 7.2 Terminal-rendering library evaluation
### 7.3 Zero-dep vs. pragmatic-deps
### 7.4 Guard rewrite cost/benefit
### 7.5 Storage layer upgrade path
### 7.6 Process topology

## 8. Questions AJ should have asked but didn't
```

Length: whatever the research actually requires — I would expect 8,000–15,000 words with embedded citations, not a summary. Assume I will read the entire thing carefully.

---
