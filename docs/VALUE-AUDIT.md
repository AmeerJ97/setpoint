# VALUE-AUDIT — every value on the HUD, where it comes from, why it might mislead

**Compiled:** 2026-04-20
**Purpose:** Anchor for the Phase 1 fix pass. Each row ties one displayed value to (a) the source field, (b) the formula, (c) the failure mode that makes it misleading. Read this alongside the rendered HUD before fixing anything.

**Conventions:**
- "stdin" = JSON piped into the HUD by Claude Code's `statusLine.command`
- "JSONL" = the active session transcript at `~/.claude/projects/<slug>/<session-id>.jsonl`
- "history" = `~/.claude/plugins/claude-hud/usage-history.jsonl`
- File:line references are absolute paths from the project root

---

## Line 1 — Model

| Displayed | Source | Formula / file | Failure mode |
|---|---|---|---|
| Model name (`Opus 4.7`) | `stdin.model.display_name` ‖ derived from `model.id` | `src/data/stdin.js:128` `getModelName()` — falls back to Bedrock parsing for inference profile ARNs | None significant. |
| Effort badge (`high`) | `process.env.CLAUDE_CODE_EFFORT` ‖ `~/.claude/settings.json:effortLevel` ‖ `'high'` default | `src/hud/renderer.js:238` `detectEffort()` | Stale if user changed effort via `/effort` slash command without restarting Claude Code — slash command writes settings.json so this is OK; but **doesn't know about `xhigh`** added in 2.1.111. New tier shows up as raw `xhigh` string but isn't classified. |
| Project path | `stdin.cwd` | direct | None. |
| Git branch | `git status --porcelain=v2 --branch` | `src/collectors/git.js` | None significant. |
| Session duration | `Date.now() - transcript.sessionStart` | `src/hud/renderer.js:109` | None. |

---

## Line 2 — Context

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| Headline `48%` | `stdin.context_window.used_percentage` ‖ `getBufferedPercent(stdin)` | `src/data/stdin.js:107` adds a **softened 16.5% autocompact buffer** to total/size ratio when no native `used_percentage` provided | **MISLEADING — #50204 class.** The HUD adds the autocompact buffer to inflate the displayed % so the user "sees compaction coming". But: usage-history.jsonl writes `getContextPercent` (raw). These can differ by up to ~16 pp. The HUD value is also what you'll mentally compare to `/context` output, and `/context` reports the *real* token total, not buffered. **Fix:** make the headline the JSONL-derived ground truth. Render the buffered marker as a dim secondary indicator on the gauge. |
| `(42K/200K)` | `getTotalTokens(stdin)` / `context_window_size` | `src/data/stdin.js:67` sums `input_tokens + cache_creation + cache_read` from `current_usage` | **Sums per-turn current_usage as if it's session-cumulative.** `current_usage` in the stdin payload is the **last turn**, not the session — but the formula treats it as authoritative for "total context size". Verify against JSONL `usage` per turn: the headline number can drift from real cumulative context. |
| `compact:N%` warning | Same raw % as above | shown only when buffered % ≥ 75 | OK as a warning gate, but the ratio between buffered and raw is invisible to the user. |

---

## Line 3 — Usage (5h / 7d)

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `5h: 62%` (current) | `stdin.rate_limits.five_hour.used_percentage` | `src/data/stdin.js:178` `getUsageFromStdin()` | None — server-reported truth. |
| `→ 78` (projected) | sigmoid blend of current rate vs. prior-window history, peak-hour weighted | `src/analytics/rates.js` `projectWindow()` | **Phase 1.6 fix landed.** Effective remaining time multiplied by `1 + peakFraction × (multiplier - 1)`. TTE inflated by `multiplier` while peak active. `⚡` glyph rendered on Usage line: bright yellow during active peak, dim when peak hours upcoming inside the remaining window. Default `[5,11]` PT, 1.5× multiplier (configurable in `config/defaults.json` → `rates.peakHours`). |
| `2h15m` reset | `parseRateLimitResetAt(rate_limits.five_hour.resets_at)` | `src/data/stdin.js:169` | None. |
| `7d: 38%` (current) | `stdin.rate_limits.seven_day.used_percentage` | direct | None. |
| 7d projected | same `projectWindow()` with `windowSec=7×86400`, scaled by `activeHoursPerDay/24` (default 10/24) | `src/analytics/rates.js:68` | **Hard-coded `activeHoursPerDay=10`** in `config/defaults.json:42`. Doesn't adapt to the user's actual usage pattern. After Phase 2 we should derive this from history. |

---

## Line 4 — Tokens

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `in:42K out:9.5K` | `tokenStats.totalInput` / `totalOutput` | `src/hud/renderer.js:190` `augmentTokenStats()` takes `Math.max(cached, stdin)` per field | The "cached" side comes from the analytics daemon's per-session JSON; stdin gives current turn. `Math.max` is a heuristic that prevents stdin from dragging a stale cache backwards but doesn't reconcile per-turn vs cumulative semantics. Acceptable. |
| `cache: 69%` | `cacheRead / (cacheCreate + cacheRead)` over **session lifetime** | `src/display/lines/tokens.js:38` | **Session-cumulative dilutes the signal.** A bad cache run early in the session is masked by an hour of good cache reads later. The point of monitoring cache % is to catch *current* regressions (#46829). **Fix:** rolling 10-turn window. Also add **TTL split overlay** (`5m: 80% / 1h: 20%`) so #46829-style silent regression to 5m TTL is visible. |
| `burn: 211t/m` | `freshOutput / durationMin` | `src/hud/renderer.js:218` | **Output-only.** A turn that reads a 100K-token codebase with minimal output shows near-zero burn. But it cost real quota (input + cache_create are billed). **Fix:** weight by per-MTok price for the active model and report a cost-relevance burn rate. Also add EWMA smoothing (α=0.2) so single bursty turns don't dominate. |
| `18 calls` | `tokenStats.apiCalls` | analytics daemon | None. |
| `~$0.42` | `(input + output) / 1e6 × pricing` | `src/analytics/cost.js:63` `calculateCost()` — **explicitly excludes cache_create and cache_read** | **Documentation gap, not a bug.** The cost.js comment explains why caches are excluded (Pro/Max users don't pay per-token, cache_read is cumulative and balloons). Acceptable as designed but the user should know "cost" here = generation only. |
| `R:E 4.2 (28r/7e)` | `tools.Read / tools.Edit` from transcript | `src/anomaly/constants.js:59` | OK. Threshold-correlated to anomaly rules. |
| `rtk:42K↓88%` | RTK cache stats | `src/collectors/rtk-reader.js` | None. |

---

## Line 5 — Env

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `main:high \| sub:sonnet` | `ctx.effort` + sub-agent detection | `src/display/lines/env.js` | Sub-agent model detection unreliable when sub-agents inherit parent model. |
| `13r 7h 2md` | `rulesCount` `hooksCount` `claudeMdCount` | `src/collectors/config-reader.js` | Opaque labels — known issue from research brief §2.2. **Fix in Phase 5 polish.** |
| `UNCOMP` / `COMP` | `tengu_summarize_tool_results` cached value | `src/data/config.js` | Reads cached flag value. If guard's `summarize` category is skipped, UNCOMP shown but compression actually active. |

---

## Line 6 — MCPs

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `3/22 active` | scan of session JSONL for `mcp__*` tool invocations in last N turns | `src/collectors/session-scanner.js` `getActiveMcpNames()` | OK heuristic. Doesn't surface MCP token cost (could be 22K per server per #46917 Asana note). **Fix in Phase 4: surface MCP token cost on the context grid.** |

---

## Line 7 — Guard

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `✓17/17 held` | `categoryOrder().length` from `loadDefaults().guard.categories` — `guard.skippedCount` | `src/display/lines/guard.js` (`categoryOrder()` helper) | **Phase 1.5 fix landed.** The count is read from `config/defaults.json` at render time; adding or removing a category updates the display without a code change. |
| `last:brevity 2m` | `/tmp/claude-quality-guard.log` tail | `src/collectors/guard-reader.js` | OK. |
| `↻4 today` | log scan | OK. |

**Per-category drift** is invisible. The brief recommends a 17-glyph ribbon (one block char per category). Implemented in Phase 5.

---

## Line 8 — Advisor

| Displayed | Source | Formula | Failure mode |
|---|---|---|---|
| `▼ /compact — context > 60%` | engine action ladder over `(TTE, peak burn velocity, R:E, context%)` | `src/advisor/engine.js` (consumed via `src/analytics/advisor.js`) | **Phase 2 fix landed.** Replaced the 5-precedence static ladder with an action-oriented engine: hard-stop (TTE < 30m / 12h) → model swap (Opus + peak + burn > 2.5×P50) → /clear (R:E < 3.0) → /compact (context > 60%) → on-track. Confidence dims the badge when session is young (<15min OR <5 turns). Personal P50/P90 baselines kick in after ≥7 days of history (≥50 samples). Old `effort-matrix.js` deleted. |

---

## Pricing accuracy

**Audit error in v1 of this document.** The original audit asserted "existing config matches Anthropic's published baseline ($15/$75 for Opus)" and recommended keeping the existing rates. That was **wrong**. Phase 1.1 implementation fetched live rates from `https://platform.claude.com/docs/en/about-claude/pricing` and confirmed the **research brief was correct** about Opus 4.7 / 4.6 / 4.5 — those models all dropped to $5 input / $25 output (vs. the $15/$75 of Opus 4.1 and prior).

**Current verified pricing** (per `platform.claude.com/docs/en/about-claude/pricing`, fetched 2026-04-20):

| Model | Input | Output | 5m CacheWrite | 1h CacheWrite | CacheRead |
|---|---|---|---|---|---|
| Opus 4.7 | $5 | $25 | $6.25 | $10 | $0.50 |
| Opus 4.6 | $5 | $25 | $6.25 | $10 | $0.50 |
| Opus 4.5 | $5 | $25 | $6.25 | $10 | $0.50 |
| Opus 4.1 | $15 | $75 | $18.75 | $30 | $1.50 |
| Sonnet 4.6 | $3 | $15 | $3.75 | $6 | $0.30 |
| Sonnet 4.5 | $3 | $15 | $3.75 | $6 | $0.30 |
| Haiku 4.5 | $1 | $5 | $1.25 | $2 | $0.10 |

**Implications for the displayed `~$0.42` cost figure:**
- Pre-Phase 1.1, Opus 4.7 sessions were over-reporting cost by **3×** (config said $15/$75; actual is $5/$25). Anyone tuning behavior off the displayed cost was working from a number 3× too high.
- The cost figure is still generation-only (input + output, cache excluded). That design choice is correct — see `src/analytics/cost.js` comment block.

**Other notes from the live pricing page:**
- Opus 4.7 uses a **35% larger tokenizer** for the same fixed text (Anthropic note). The displayed `in:` and `out:` token counts will appear inflated vs. older Opus runs, but the cost numbers are correct because rates dropped proportionally.
- `xhigh` effort tier (added 2.1.111) is **not a separate price tier** — it's an effort level applied to Opus 4.7's standard $5/$25 pricing.
- US-only data residency (`inference_geo`) adds a **1.1× multiplier** on Opus 4.5+ models, opt-in via the `dataResidencyMultiplier` config (default 1.0 = off).
- Bedrock / Vertex regional endpoints carry a 10% premium over global routing (Sonnet 4.5+ / Haiku 4.5 only). Not currently surfaced; tracked for future work.

**Phase 1.1 fix landed:** `config/defaults.json` pricing block rewritten with verified rates, 5m/1h cache write split, Opus 4.5 / Opus 4.1 / Sonnet 4.5 added. `src/analytics/cost.js` extended with `perTokenWeights()` for the burn-rate rewrite (Phase 1.2) and `getDataResidencyMultiplier()` honoring the new config field.

---

## Cross-reference: known bugs that require value changes

| Bug | Affected value | Fix in |
|---|---|---|
| #46917 — token inflation v2.1.100+ | None (mitigated by User-Agent spoof outside this codebase) | N/A |
| #46829 — cache TTL silent regression to 5m | Cache % on Tokens line | Phase 1.4 — TTL split overlay |
| #50204 — UI % under-reports vs JSONL | Headline Context % | Phase 1.3 — switch to JSONL truth |
| #41930 — peak-hour multiplier on session limits | 5h projection | Phase 1.6 — peak-hour weighting |
| #42796 — R:E ratio collapse | R:E badge (already shown), advisor recommendations (not yet) | Phase 2 — advisor engine |
| #38029 — phantom output tokens on resume | Burn rate, output count | Phase 3 — anomaly check on session start |
| #50083 — 1M context silently dropped to 200K | Context line size denominator | OK if `context_window_size` in stdin is updated by CC; verify during Phase 1.3 |

---

## What this audit does NOT cover

- Health-report values (`Line 6 MCPs` partially) — separate audit pass after Phase 4.
- Anomaly thresholds — addressed in Phase 5 polish.
- Sub-agent detection accuracy — out of scope; tracked separately.
- Color/glyph correctness — visual polish, Phase 5.
