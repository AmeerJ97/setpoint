<p align="center">
  <img src="docs/assets/brand/hero.svg" alt="claude-ops terminal HUD for Claude Code operations" width="900" />
</p>

<h1 align="center">claude-ops</h1>

<p align="center"><em>Operational telemetry, billing awareness, guardrails, and repair tooling for Claude Code.</em></p>

<p align="center">
  <a href="https://github.com/AmeerJ97/claude-ops/actions/workflows/test.yml"><img src="https://github.com/AmeerJ97/claude-ops/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/dependencies-0-blue" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/platform-linux-lightgrey" alt="Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

`claude-ops` is a local operations toolkit for Claude Code. It renders an always-on terminal HUD, tracks subscription quota or API-billing cost, watches session health, surfaces advisor recommendations, audits Claude Code configuration drift, and repairs local install wiring.

It is designed for operators who keep multiple Claude Code sessions open and need to know, at a glance, what the current session is costing, whether context is healthy, whether Claude Code is in subscription or API billing mode, and whether local guardrails are still intact.

## What It Does

| Area | Capability |
|---|---|
| HUD | Multi-line `statusLine` renderer fed by Claude Code stdin JSON. |
| Billing modes | Pro/Max subscription quota gauges when `rate_limits` exist; API/Console/Gateway cost gauges when they do not. |
| Advisor | Burn-rate, context pressure, read/edit ratio, confidence, and action recommendations. |
| Analytics | Per-session token stats, cost history, cache efficiency, and multi-session isolation. |
| Health | Local audits for Claude config, MCP drift, session bloat, and stale reports. |
| Doctor/repair | Read-only diagnostics plus an explicit repair path for CLI links, statusLine config, and user services. |
| Guard | Audit-first quality guard for known Claude Code GrowthBook/config drift, with opt-in enforcement. |

The HUD keeps each signal in one primary place: provider/backend appears once
on the Model row, Context shows context pressure, Usage shows quota or cost
windows, and Tokens carries native prompt-cache state, cache efficiency, RTK
state, burn, calls, and session cost.

## Representative HUD

The current HUD is terminal-first and dense. A representative live subscription
session looks like this:

```text
Model   ▲ [ANTHROPIC-PRO] [Opus 4.7 (1M context) medium] prod  ⏱ <1m
Context █░░░░░░░░░░░░ 6%  (111K/1.0M)
Usage   5h ███░░░░░░░░ 48m │ 7d ████████░░░░ 2d 23h
Tokens  in:55K out:13 cache-hist:██ 30% │ native:on  cfg:1h  rtk:stale  burn:13 t/m
Env     main:medium · sub:opus │ 8r 11md │ UNCOMP
MCPs    0/2 active │ x1 idle · x1 fail
Guard   ◌ AUDIT docs:ok │ int:10 probes (8 raw) / skip:1
Advisor 7d ... │ TTE ... │ conf:low │ ⚠ on track — proceed
        5h ... │ TTE ... │ conf:low │ △ cache tokens dominate this session...
```

Claude Code banners above the HUD, such as `auto mode is unavailable for your plan`,
are upstream Claude Code UI. Claude Ops does not own or suppress those notices.

## Install

```bash
git clone https://github.com/AmeerJ97/claude-ops
cd claude-ops
bash scripts/install.sh
```

The installer copies the package into a managed install root, writes a real executable launcher at `~/.local/bin/claude-ops`, configures Claude Code's `statusLine` to run the installed `src/cli/index.js`, migrates old plugin state when present, installs the on-demand analytics collector, installs health/advisor timers, repairs docs-backed guard controls in `settings.json`, and installs the guard in the selected mode. Source-checkout installs do not rely on `npm link` or a local-bin symlink.

When you run the installer from a checkout, it preserves the current owned live install root when one already exists. Override that target explicitly with `CLAUDE_OPS_INSTALL_DIR=/path`.
Choose the install-time guard mode with `CLAUDE_OPS_GUARD_MODE=audit|enforce|disabled`.

The analytics collector is not an always-on background task by default. Claude Code statusLine renders wake `claude-ops-analytics.service` while Claude Code is open, and the collector exits after idle time when no Claude Code sessions are active. Inspect or stop it with `claude-ops analytics status` and `claude-ops analytics stop`.

The guard mode is configurable. The default install mode is `audit`. Switch it at any time:

```bash
claude-ops guard mode enforce
claude-ops guard mode audit
claude-ops guard mode disabled
```

Rollback:

```bash
bash scripts/rollback.sh
```

## CLI

### Core

```bash
claude-ops
claude-ops doctor [--json]
claude-ops repair [--apply] [--json]
claude-ops health [--json]
claude-ops advisor
claude-ops advisor status [--json]
claude-ops context [--json] [--session|--latest]
claude-ops usage [--json] [--since 7d]
claude-ops demo
```

### Guard

```bash
claude-ops guard status [--json]
claude-ops guard validate [--json]
claude-ops guard repair [--apply]
claude-ops guard mode [audit|enforce|disabled|status]
```

### Vertex

```bash
claude-ops vertex status [--json]
claude-ops vertex discover [--json]
claude-ops vertex use ...
claude-ops vertex switch <haiku|sonnet|opus>
claude-ops vertex cache <off|5m|1h>
claude-ops telemetry vertex collect
```

### Session Tuning

```bash
claude-ops skills status|quarantine|restore
claude-ops effort [<level>] [--json]
claude-ops auto-effort [on|off|status]
claude-ops analytics status [--json]
```

### Experimental

```bash
claude-ops scan [--json] [--qmd COLL]
claude-ops consolidate ...
```

## Billing Modes

Claude Ops treats billing mode as a first-class runtime signal.

| Mode | Signal | HUD behavior |
|---|---|---|
| Subscription | Claude Code provides `rate_limits` in statusLine stdin. | Shows 5h and 7d quota windows, projections, and time-to-exhaustion. |
| API billing | `rate_limits` are absent and API/Console/Gateway/provider env is detected. | Shows estimated billable session cost, cost burn, historical local references, and low-confidence quota-free advisor output. |
| Unknown/offline | No auth signal and no `rate_limits`. | Degrades to cost-style display without pretending quota data exists. |

API billing mode is intended for Claude Code sessions authenticated through Console/API key, auth-token gateway, Anthropic-compatible base URL, Bedrock, Vertex, or Foundry rather than the standard subscription account path. Claude Ops uses Claude Code's native `cost.total_cost_usd` statusLine field when present; otherwise it computes local estimates from token telemetry and current pricing. Subscription/reference cost stays generation-only, while API billable estimates include input, output, cache writes, and cache reads. Historical 5h/7d values are local references, not account limits. API references exclude the current session and stay in cold-start/warming state until enough local history exists.

Prompt caching is still worth enabling on Vertex for repeated static prefixes, but it does not reduce logical context window occupancy on its own. If a trivial prompt already consumes a large percentage of context, that points to a large static prompt surface or misbehaving skills/tooling, not just a missing cache toggle.

Vertex is fail-closed by default: the Model row labels `[VERTEX-AI]`, while
Usage stays in a missing-or-metrics-only state until a fresh,
project/region/model-matched snapshot exists. Advisor does not repeat that
failure detail; it stays focused on the action. Token-only Cloud Monitoring
snapshots render as metrics-only and keep advisor confidence capped; snapshots
become provider-backed only when cost windows are complete.

```bash
claude-ops telemetry vertex collect --json \
  --project "$ANTHROPIC_VERTEX_PROJECT_ID" \
  --region "$CLOUD_ML_REGION" \
  --model "$ANTHROPIC_MODEL"
```

For Vertex config audits, `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, and either `CLOUD_ML_REGION` or a `VERTEX_REGION_CLAUDE_*` override are considered the required signals. `CLAUDE_CODE_USE_VERTEX=0` explicitly disables Vertex HUD detection even if project/region variables are inherited.

## Runtime Layout

Claude Ops stores runtime state under:

```text
~/.claude/plugins/claude-ops/
```

Important files:

| Path | Purpose |
|---|---|
| `token-stats/<session>.json` | Live per-session stats read by the HUD. |
| `usage-history.jsonl` | Append-only usage and cost history. |
| `vertex-api-telemetry.json` | Optional Vertex token/cost snapshot read by the HUD. |
| `health-report.json` | Latest health audit result. |
| `daily-report.md` | Latest advisor report. |
| `anomaly-log.jsonl` | Alert history. |
| `guard-config/` | Guard category skip/enable state. |

Guard activity is logged to:

```text
~/.claude/plugins/claude-ops/guard.log
```

## Architecture

```text
Claude Code statusLine stdin
          |
          v
  claude-ops HUD renderer  ---- reads ----> ~/.claude/plugins/claude-ops/
          ^
          |
 analytics collector <--- session JSONL transcripts
 health timer      ----> health-report.json
 advisor timer     ----> daily-report.md
 guard             <---- ~/.claude.json / GrowthBook cache
```

The HUD renderer is one-shot and must stay fast. Background services do slower work and communicate through small JSON/JSONL files.

## Guard Posture

The guard exists because Claude Code can change feature/config state outside the visible UI. Claude Ops keeps the guard audit-first by default:

- `claude-ops guard status` separates documented/hybrid controls from internal GrowthBook probes. By default it is read-only and exits zero; use `--strict` when docs-backed drift should fail CI/smoke checks.
- `claude-ops guard mode` controls live posture explicitly: `audit` keeps the guard installed but inactive, `enforce` starts the user service, and `disabled` sets the guard-disabled flag and stops the service.
- `claude-ops guard validate` checks documented Claude Code env/settings controls without mutating local config.
- `claude-ops guard repair` writes the supported docs-backed control defaults into `settings.json.env` so install/smoke flows can clear official drift without manual editing.
- `claude-ops doctor` now also surfaces oversized skill corpora, large static prompt floors, and Vertex cache-policy recommendations when the local setup is likely to waste context or repeated billing on trivial prompts.
- `MAX_THINKING_TOKENS` is informational while Claude Code adaptive thinking is enabled; it becomes an enforceable fixed-budget drift check only when `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` is truthy.
- `claude-ops doctor` reports guard `audit` / `enforce` / `disabled` mode and the default Opus 4.7 `thinking` skip reason when present.
- The Rust guard binary is installed when `cargo` is available.
- Enforcement is opt-in and can be switched at any time with `claude-ops guard mode enforce`.
- Local wiring repair does not silently change the current guard mode.

## Vertex CLI

- `claude-ops vertex status` reads the persisted Vertex project, region, family pins, prompt-cache mode, static prompt estimate, and any cached discovery snapshot.
- `claude-ops vertex discover --refresh` uses ADC plus the Vertex publisher-model API to sweep Anthropic Claude models across common regions and cache the results locally.
- `claude-ops vertex use --project ... --region ... --active haiku|sonnet|opus --cache 1h` writes a complete Claude Code Vertex setup into `settings.json`.
- `claude-ops vertex switch haiku|sonnet|opus` changes the active Claude family without manual settings edits.
- `claude-ops vertex cache 1h` enables one-hour prompt-cache TTL for supported models.

## Skills And Context

- `claude-ops skills status` reports how many active skills are present, how many are invalid or oversized, and how much prompt surface they represent.
- `claude-ops skills quarantine --apply` moves invalid or oversized skills into `~/.claude/skills.quarantine` with a manifest so they can be restored later.
- `claude-ops skills restore --all` restores everything from quarantine.
- `claude-ops context --latest --json` reads the newest transcript on disk when active-session metadata is stale, which is useful for understanding prompt-surface bloat after the fact.

## Limitations And Current Rough Edges

- Context and compaction are approximations. `claude-ops context` estimates the
  prompt surface and reservation buffer, but it does not have privileged access
  to Claude Code's exact compaction boundary or server-side prompt packing.
- Prompt caching improves repeated billing/reuse. It does not, by itself, make
  the headline Context percentage smaller.
- Vertex telemetry is intentionally fail-closed. If provider-backed cost windows
  are missing, Claude Ops reports that honestly instead of inventing quota or
  billing certainty.
- `scan` and `consolidate` remain experimental. They are useful for operator
  investigation, but they are not presented as a fully-stable workflow.
- Claude plan entitlements are upstream. If Claude Code says auto mode is not
  available for your plan, Claude Ops cannot enable it.

## Effort

`claude-ops effort` persists only Claude Code's durable levels: `low`, `medium`, `high`, and `xhigh`. `default` removes the persisted setting. `max` is treated as a session/env-only override; use `CLAUDE_CODE_EFFORT_LEVEL=max` when a one-off session needs it.

## Environment

| Env | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR=/path` | Override `~/.claude`. |
| `CLAUDE_OPS_CLAUDE_JSON_PATH=/path` | Override Claude Code's global state JSON path. |
| `CLAUDE_OPS_INSTALL_DIR=/path` | Override the package-copy install directory; default `~/.local/share/claude-ops`. |
| `CLAUDE_OPS_BIN_DIR=/path` | Override the launcher directory; default `~/.local/bin`. |
| `CLAUDE_OPS_ANALYTICS_POLL_MS=30000` | Tune analytics collector polling; values below 5000ms are clamped. |
| `CLAUDE_OPS_RTK_POLL_MS=300000` | Tune optional RTK probe polling; values below 60000ms are clamped. |
| `CLAUDE_OPS_ANALYTICS_IDLE_EXIT_MS=120000` | Exit the collector after idle time; values below 30000ms are clamped. |
| `CLAUDE_OPS_ANALYTICS_START_THROTTLE_MS=60000` | Throttle HUD wakeups of the collector. |
| `CLAUDE_OPS_ANALYTICS_KEEPALIVE=1` | Keep the analytics collector running continuously. |
| `CLAUDE_OPS_DISABLE_ANALYTICS=1` | Stop HUD renders from waking the analytics collector. |
| `CLAUDE_OPS_DISABLE_RTK=1` | Disable optional RTK probes in the analytics collector. |
| `CLAUDE_OPS_PRICING_FILE=/path.json` | Override model pricing. |
| `CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE=/path.json` | Override the Vertex provider telemetry snapshot path. |
| `CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES=15` | Override snapshot staleness cutoff; `0` disables the cutoff and is reported as risky. |
| `CLAUDE_OPS_VERTEX_REQUIRE_API_TELEMETRY=0` | Allow synthetic/metrics-only Vertex fallback; reported as a bypass. |
| `CLAUDE_OPS_DEFAULTS_FILE=/path.json` | Override the defaults blob. |
| `CLAUDE_OPS_HOOK_MODE=advisory|blocking` | Select hook output mode; default is advisory. |
| `CLAUDE_OPS_PRECOMPACT_SNAPSHOTS=1` | Capture optional local snapshots for `PreCompact` hooks. |
| `CLAUDE_OPS_INSTALL_PRECOMPACT_HOOK=1` | Register the optional `PreCompact` hook during hook install. |
| `CLAUDE_OPS_EXPERIMENTAL=1` | Opt into mutating experimental commands such as `consolidate apply`. |
| `CLAUDE_OPS_PALETTE=rag|cividis` | Select HUD color palette. |
| `CLAUDE_OPS_NERD=1` | Enable Nerd Font glyphs. |
| `CLAUDE_OPS_PLAIN=1` | Force ASCII-friendly output. |
| `NO_COLOR=1` / `FORCE_COLOR=0` | Disable color output. |

## Development

```bash
npm test
cargo test --manifest-path src/guard/rust/Cargo.toml
npm run check:syntax
npm run smoke:install
npm run pack:check
```

Smoke tests:

```bash
node src/cli/index.js help
node src/cli/index.js < tests/fixtures/statusline/subscription.json
node src/cli/index.js < tests/fixtures/statusline/api-billing.json
```

Install smoke without touching real user services:

```bash
tmp="$(mktemp -d)"
CLAUDE_CONFIG_DIR="$tmp/.claude" \
CLAUDE_OPS_SYSTEMD_USER_DIR="$tmp/systemd" \
CLAUDE_OPS_BIN_DIR="$tmp/bin" \
CLAUDE_OPS_SKIP_SYSTEMCTL=1 \
  bash scripts/install.sh
```

## Related Tools

| Project | Relationship |
|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) | Retrospective Claude Code usage analysis. |
| [ccstatusline](https://github.com/sirmalloc/ccstatusline) | Display-focused statusLine tooling. |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | External burn-rate monitor. |
| [CCometixLine](https://github.com/Haleclipse/CCometixLine) | Rust statusLine renderer. |

Claude Ops is intentionally local-first, terminal-native, and zero-runtime-dependency.

## License

[MIT](LICENSE)
