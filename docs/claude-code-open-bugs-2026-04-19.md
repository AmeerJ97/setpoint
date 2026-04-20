# Claude Code open issues — HUD guard reference
**Compiled:** 2026-04-19
**Source:** github.com/anthropics/claude-code issue tracker, open issues with `has repro` label or detailed proxy/binary analysis, cross-referenced with community investigations.
**Filter applied:** Open + (labeled `has repro` OR documented reproduction steps OR binary/proxy analysis OR reproduced across multiple accounts).

## How to read "verified"
GitHub applies a `has repro` label to issues where Anthropic triage confirms detailed reproduction steps. That's not the same as "Anthropic agrees the root cause is as stated" — several of these have competing Anthropic statements. I've marked each with what level of corroboration exists.

- **🟢 Confirmed by Anthropic** — Anthropic commented acknowledging the bug
- **🟡 Has-repro label + community reproduced** — Triage confirmed repro, multiple users reproduced independently
- **🟠 Binary/proxy analysis, no Anthropic confirmation** — Hard technical evidence from reverse engineering or HTTP proxy, Anthropic hasn't confirmed (and in some cases has denied)
- **⚫ Open, documented, not widely reproduced** — One or few reports with clear repro steps

---

## 1. TOKEN INFLATION / BILLING DRAIN

### 🟠 #46917 — v2.1.100+ inflates cache_creation by ~20K tokens vs v2.1.98 (server-side)
- Status: Open, no fix as of April 13
- Evidence: HTTP proxy comparison of identical `--print "1+1"` cold-cache requests. v2.1.100 sent **978 fewer bytes** but was **billed 20,196 MORE tokens** than v2.1.98. Bimodal distribution confirmed across 40+ sessions.
- Mechanism: Server-side routing on User-Agent string. Same payload, same account, different version string → different token count.
- Anthropic response (Lydia Hallie, April 2): *"none were over-charging you"* — community disputes this with proxy data.
- **HUD-guardable:** Pin to v2.1.98, or spoof User-Agent via `ANTHROPIC_CUSTOM_HEADERS='User-Agent: claude-cli/2.1.98 (external, sdk-cli)'`

### 🟡 #41930 — Widespread abnormal usage drain across all paid tiers (since March 23, 2026)
- Status: Open
- Evidence: Hundreds of users across Pro / Max 5× / Max 20× hitting 5-hour session cap in as little as 19 minutes. Single prompts consuming 3–7% of session quota. Reverse-engineering of the standalone binary (Ghidra + MITM + radare2) identified two independent bugs:
  - **Bug A — Billing sentinel string replacement:** Anthropic's custom Bun fork performs a string replacement on every API request targeting a billing attribution sentinel. If the conversation mentions billing-related terms, the replacement hits the wrong position, breaking the cache prefix and forcing full uncached token rebuild. Uncached tokens cost 10–20× more against quota.
  - **Bug B — Resume/continue flag cache invalidation:** `--resume` or `--continue` injects tool attachments at a different position than fresh sessions, invalidating the entire conversation cache.
- Anthropic response: Peak-hour throttling confirmed March 26. No comment on the two cache bugs.
- **HUD-guardable:** Avoid `--resume`/`--continue` flags. Run via `npx @anthropic-ai/claude-code` to bypass the Bun fork. Use `/clear` instead of continuation.

### 🟡 #46829 — Cache TTL silently regressed from 1h to 5m in early March 2026
- Status: Open
- Evidence: Analysis of 119,866 API calls from Jan 11 – Apr 11, 2026 across two machines. `usage.cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens` per-call breakdown shows silent reversion of default TTL. 20–32% measured overpayment. February (1h TTL) showed 1.1% waste; post-March (5m TTL) shows 15–53% overpayment.
- Mechanism: 5m TTL means any pause >5 min forces full cache_creation on next turn at the write rate ($6.25/MTok for Opus 4.6) instead of cache_read ($0.50/MTok).
- **HUD-guardable:** No direct override exposed. Your HUD's `refresh_ttl` category was trying to push back on this. Validate with: `jq '.message.usage.cache_creation' ~/.claude/projects/*/*.jsonl`

### 🟡 #42338 — Session resume (--continue) completely invalidates prompt cache
- Status: Closed (but closure disputed — same behavior reproduced in #42749 on v2.1.90)
- Evidence: On a 1M context Opus 4.6 session with ~500K prompt, re-entering with `--continue` within 2–3 seconds drops `cache_read` to 0 and re-caches the entire prompt. Burns 400–500K tokens on each resume.
- **HUD-guardable:** Don't resume. Start fresh or use Citadel's own state-persistence layer.

### 🟠 #42647 — Compaction loops cause 50K–300K token burn per event
- Status: Open
- Mechanism: Main `while (true)` query loop resends entire message history, system prompt, and tool schemas on every retry with no deduplication. Autocompact triggers at ~187K, submits the bloated context for summarization, can cascade up to 3× per turn.
- **HUD-guardable:** Cap compaction cascades via hook. Your `compact_init` / `compact_max` categories address this.

### 🟡 #38029 — Session resume generates phantom output tokens (652K without user prompts)
- Status: Open, partial fix shipped same day ("Improved memory usage and startup time when resuming large sessions")
- Evidence: `ccusage` breakdown showed 652,069 output tokens generated on resume without any user prompt. Usage hit 80% on launch, 100% within 45 minutes of minimal interaction.
- **HUD-guardable:** Observation only — monitor output token count on session start.

---

## 2. CONTEXT / COMPACTION

### 🟡 #50083 — 1M context window silently removed for Max 5x in v2.1.112
- Status: Open (regression in v2.1.112)
- Evidence: Upgrading from v2.1.97 → v2.1.112 silently drops context from 1M to 200K on Max 5× accounts. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` env var exists but clamped via `Math.min(modelWindow, configured)`. Auto-compaction now fires at ~167K (200K minus 33K buffer) instead of ~967K. Long sessions compact every 15–20 exchanges instead of every several hours.
- **HUD-guardable:** Stay on v2.1.98 (before this regression). `willow_mode` category in your guard was likely addressing this pattern.

### 🟠 #50204 — Auto-compact triggers prematurely; UI % under-reports by ~2×
- Status: Open
- Evidence: On `claude-opus-4-7[1m]`, UI showed 60% while actual `cache_read_input_tokens` hit 1,244,198 (124% of 1M window). UI denominator wrong for 1M variants.
- **HUD-guardable:** Parse actual tokens from `.jsonl` rather than trusting UI %.

### 🟡 #42590 — Context compaction too aggressive on 1M context (Opus 4.6)
- Status: Open
- Evidence: 1M context sessions compact at same threshold as smaller windows, losing ~90% of intermediate work product.
- **HUD-guardable:** Requires `context_threshold` setting (#46695, open feature request).

### 🟡 #47145 — Autocompact silently destroys active session work (no consent dialog)
- Status: Open
- Evidence: 10-second non-interactive notification is insufficient. Compaction summaries frequently drop critical work product (architectural decisions, pricing models, code). Raw `.jsonl` transcript retains everything proving data existed and was selectively dropped.
- **HUD-guardable:** Implement PreCompact via hooks; #43946 tracks the feature request.

### 🟠 #29230 — v2.1.62 KV cache stale-context P1 regression (post-compaction)
- Status: Old but demonstrates the failure mode — model acts on stale context with high confidence, resists explicit user redirection.
- Evidence: Binary diff shows v2.1.61 → v2.1.62 identical except VERSION + BUILD_TIME. Server-side KV cache change increased prefix hit rates without adding compaction-event invalidation. `--no-compaction` avoids the bug.
- **HUD-guardable:** Flag command available. Use when symptoms appear.

### 🟡 #27048 — Tool-use content not cached across session resumes, plugin toggles rewrite cache
- Status: Open
- Evidence: Read operations fail to cache across resumes. Cache reads decrease while writes increase — in heavy-read sessions, 98K of cached content isn't retrieved; 91K written instead (complete re-evaluation).
- **HUD-guardable:** `tool_persist` category in your guard addressed this.

---

## 3. MODEL / QUALITY

### 🟡 #35297 — Heavily degraded model performance during off-peak hours
- Status: Open
- Evidence: Same task (UI code from Figma, same context files and standards), Opus 4.6 + high effort, one-shots fine during peak hours but "astronomical failures" off-peak requiring 1 hour of babysitting.
- Implication: Server-side routing/downgrade happening silently outside of user control.
- **HUD-guardable:** Shift intensive work to peak hours. `grey_step` / `grey_step2` / `grey_wool` categories in your guard addressed effort-reducer flags.

### (Community) Effort-level downgrades via server flags
- Documented via binary analysis and `/login` account comparisons. Effort reducers (`grey_step`, `grey_step2`, `grey_wool`) and brevity enforcers reported to activate during peak windows or account aging.
- Your `brevity`, `quiet`, `summarize`, `maxtokens`, `truncation`, `thinking`, `willow_mode` categories all addressed these.
- **HUD-guardable:** Your existing guard categories. Most of them fight GrowthBook flags that change independently of your client version.

---

## 4. AUTH / PLAN DOWNGRADE

### 🟡 #45886 / #30854 — "Your account does not have access to Claude Code. Please run /login"
- Status: Open since March 4, no Anthropic response
- Evidence: Reproduces on brand-new hardware with fresh install. Claude.ai web + desktop app work on same account. Definitively a server-side subscription validation bug.
- **HUD-guardable:** Observation only.

### ⚫ #45335 — Max 5x gift subscription auto-canceled after ~1 week (no notification)
- Status: Open, closed as `invalid`
- Mentioned for pattern-recognition; silent plan changes happen.

---

## 5. UI / WORKFLOW

### 🟠 #48806 — Claude in Chrome + Cowork Chrome failures (since April 15 Desktop update)
- Status: Open
- Mechanism: Desktop app bundles its own Claude Code binary; recent update broke Chrome extension integration. `execute_javascript` and `get_page_content` return "Google Chrome is not running" even when running.
- **HUD-guardable:** Not really. Roll back Desktop if needed.

### 🟡 #48281 — Claude Desktop Code tab crashes on open (v1.2581.0, macOS)
- Status: Open
- Error: `BuddyBleTransport reportState - No handler registered`
- **HUD-guardable:** N/A, downgrade Desktop if affected.

### ⚫ #50029 — `/ultrareview` returns empty findings `[]` on large-scope repos
- Status: Open
- Evidence: 3,318 files / +503,841 / -79,972 lines → empty findings array, deterministic. Task-notification shows "completed" but result empty.

### ⚫ #50738 — Ultraplan: stream timeouts, `cache_control cannot be set for empty text blocks`
- Status: Open (reported 2026-04-19, today)
- **HUD-guardable:** Fail-fast: if Ultraplan request returns 400, disable the feature client-side.

### 🟡 #50270 — v2.1.113+ broken on Termux/Android (glibc-only binary, no JS fallback)
- **HUD-guardable:** N/A unless deploying to Android.

---

## 6. PATTERN-LEVEL: "GROWTHBOOK REVERTS"

Your existing guard categories were each fighting specific server-side flags. What's now documented:

| Your category | Maps to public issue | Status |
|---|---|---|
| `brevity` | Effort reducers (#35297 indirectly) | Server-side flag, no public tracking issue |
| `quiet` | Tool output suppression | Server-side |
| `summarize` | Compaction aggressiveness (#42590, #47145) | Open |
| `maxtokens` | Output token caps | Server-side, version-coupled |
| `truncation` | Tool output truncation | Server-side |
| `refresh_ttl` | #46829 (1h → 5m TTL revert) | Documented, open |
| `mcp_connect` | Server-side MCP connector bloat (#46917 mentions Asana path) | Partial |
| `bridge` | Claude Desktop bridge (#48806 related) | Open |
| `grey_step` / `grey_step2` / `grey_wool` | Effort-reducer flags | Server-side |
| `thinking` | Thinking budget | Server-side |
| `willow_mode` | Capability downgrade (#50083 related) | Open |
| `compact_max` / `compact_init` | #50204, #42590, #50083 | Open |
| `tool_persist` | #27048 | Open |
| `chomp` | Adaptive processing | Server-side |

**Net-net for your guard:** The 17 categories you already have map well to documented issues. The guard logic is not the problem — Anthropic changing behavior faster than the guard can adapt is the problem. The only way to actually win is:

1. **Version pin + auto-update off** — you did this (2.1.98 + DISABLE_AUTOUPDATER)
2. **User-Agent spoof** — community workaround for #46917 server routing
3. **Avoid `--resume` / `--continue`** — mitigates #42338 and cascade-in #41930
4. **Use `/clear`, not long sessions** — avoids cache invalidation from plugin-toggle / account-switch events
5. **Parse `.jsonl` for real token counts** — don't trust the statusline percentage (#50204)
6. **Monitor `cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h`** — alert when 5m % exceeds threshold (#46829 detection)

---

## 7. ACTIONABLE HUD ENHANCEMENTS

Based on the above, categories your guard should add or strengthen:

1. **Cache TTL telemetry** (#46829) — Parse per-call TTL tier split, alert when 5m ratio > 30%
2. **Version lock enforcement** — Verify `claude --version` matches expected, alarm on mismatch
3. **Binary fingerprint monitor** — MD5 of the claude binary, alert on change (catches silent binary swaps even when version string is pinned)
4. **User-Agent check** — Verify outgoing `User-Agent` header via local proxy, enforce `claude-cli/2.1.98 ...` spoof
5. **Phantom output detector** (#38029) — On session start, threshold on output tokens before first user prompt
6. **PreCompact capture** — Write session state before compaction via hook (addresses #47145 / #43733)
7. **MCP tool count guard** — `/doctor` shows MCP context in tokens. Alarm when > 30K; many are server-side OAuth connectors (see #46917 notes on Asana path, 22K tokens for one connector)

---

## SOURCE LINKS

Primary (sorted by impact):
- #41930 — https://github.com/anthropics/claude-code/issues/41930
- #46917 — https://github.com/anthropics/claude-code/issues/46917
- #46829 — https://github.com/anthropics/claude-code/issues/46829
- #50083 — https://github.com/anthropics/claude-code/issues/50083
- #42338 — https://github.com/anthropics/claude-code/issues/42338
- #42590 — https://github.com/anthropics/claude-code/issues/42590
- #47145 — https://github.com/anthropics/claude-code/issues/47145
- #42647 — https://github.com/anthropics/claude-code/issues/42647
- #50204 — https://github.com/anthropics/claude-code/issues/50204
- #38029 — https://github.com/anthropics/claude-code/issues/38029
- #27048 — https://github.com/anthropics/claude-code/issues/27048
- #35297 — https://github.com/anthropics/claude-code/issues/35297
- #29230 — https://github.com/anthropics/claude-code/issues/29230

Cache invalidation reverse-engineering (ArkNill): https://github.com/ArkNill/claude-code-cache-analysis
Reddit investigation (Adrian/proxy): https://www.reddit.com/r/ClaudeCode/comments/1sj10ou/

Press coverage:
- The Register — https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/
- Efficienist — https://efficienist.com/claude-code-may-be-burning-your-limits-with-invisible-tokens-you-cant-see-or-audit/
- Awesome Agents — https://awesomeagents.ai/news/claude-code-phantom-tokens-billing-inflation/

---

## NOTES ON WHAT I COULDN'T VERIFY

- Exhaustive enumeration of GrowthBook flags in the binary — your guard's list (17 categories) appears more complete than what's publicly documented. Binary reverse-engineering covers sentinel-replacement and resume-cache but doesn't enumerate flag names.
- Whether v2.1.104 / v2.1.112 / v2.1.114 carry the #46917 inflation. The issue states these are untested. Your User-Agent spoof is belt-and-suspenders.
- Whether Anthropic's "none were over-charging you" statement (April 2) covers the specific v2.1.100+ routing or refers to a different billing path. Community reads it as a general denial; Anthropic hasn't clarified.
