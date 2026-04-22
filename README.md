<p align="center">
  <img src="docs/assets/brand/hero.svg" alt="setpoint — eight-line statusLine HUD for Claude Code" width="900" />
</p>

<h1 align="center">setpoint</h1>

<p align="center"><em>Holds your Claude Code configuration at the values it was meant to have.</em></p>

<p align="center">
  <a href="https://github.com/AmeerJ97/setpoint/actions/workflows/test.yml"><img src="https://github.com/AmeerJ97/setpoint/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-brightgreen" alt="Node.js ≥ 18">
  <img src="https://img.shields.io/badge/dependencies-0-blue" alt="Zero runtime dependencies">
  <img src="https://img.shields.io/badge/platform-linux-lightgrey" alt="Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

---

Claude Code pushes effort level, thinking budget, tool-output limits, and compaction thresholds through GrowthBook and periodically reverts them to server-side defaults. `setpoint` watches those values with inotify, re-applies them in under 500 ms, and surfaces the whole control system — consumption, guard state, anomalies, recommendations — as an always-on terminal HUD.

A *setpoint* is the target value a controller maintains against disturbance. That's what this does.

## Install

One command. Clone and run:

```bash
git clone https://github.com/AmeerJ97/setpoint && cd setpoint && bash scripts/install.sh
```

That links the `setpoint` binary, wires it into `~/.claude/settings.json`
as your statusLine, installs the analytics daemon (15s per-session poll),
installs the health + advisor timers, and installs the quality guard
(Rust binary if `cargo` is present, bash fallback otherwise).

Restart Claude Code — the HUD appears above the input area.

The guard is installed but **not started** by default. Start it when
ready:

```bash
systemctl --user start claude-quality-guard
```

Uninstall with `bash scripts/rollback.sh`. Individual subsystem
installers (`scripts/install-analytics.sh` etc.) remain available if
you want to reinstall a single piece.

## CLI

```
setpoint                         render HUD (stdin JSON → 8 lines to stdout)
setpoint guard status [--json]   drilldown of the 17-category enforcement surface
setpoint context [--session <id>] [--json]   replicate the native /context bucket grid
setpoint demo                    render the HUD in every color / glyph mode
setpoint health                  run the health auditor once
setpoint advisor                 run the daily advisor once
setpoint advisor status [--json] drilldown: live recommendation, metrics, baselines, peak split, reversals, report tail
```

`setpoint guard status` prints a three-column table showing, per category, whether it is `held` / `drift` / `skipped`, the last time the guard touched it, and the expected-vs-actual value of every flag under it. `--json` emits the same schema for monitoring pipelines. The command exits non-zero when any category has drifted.

## The 17-category guard

| Category | Flag | Target |
|---|---|---|
| brevity | `tengu_swann_brevity` | `""` |
| quiet | `tengu_sotto_voce`, `quiet_fern`, `quiet_hollow` | `false` |
| summarize | `tengu_summarize_tool_results` | `false` |
| maxtokens | `tengu_amber_wren.maxTokens` | `128000` |
| truncation | `tengu_pewter_kestrel.*` (all per-tool subkeys) | `500000` |
| refresh_ttl | `tengu_willow_refresh_ttl_hours` + `tengu_willow_census_ttl_hours` | `8760` |
| mcp_connect | `tengu_claudeai_mcp_connectors` | `false` |
| bridge | `bridge.enabled` | `false` |
| grey_step | `tengu_grey_step` | `false` |
| grey_step2 | `tengu_grey_step2.enabled` | `false` |
| grey_wool | `tengu_grey_wool` | `false` |
| thinking | `tengu_crystal_beam.budgetTokens` | `128000` (Opus 4.6 and earlier; auto-skipped on install for Opus 4.7 — see below) |
| willow_mode | `tengu_willow_mode` | `""` |
| compact_max | `tengu_sm_compact_config.maxTokens` | `200000` |
| compact_init | `tengu_sm_config.minimumMessageTokensToInit` | `500000` |
| tool_persist | `tengu_tool_result_persistence` | `true` |
| chomp | `tengu_chomp_inflection` | `true` |

Categories can be individually skipped without disabling the whole guard.
Once installed, the Rust binary lives at `src/guard/rust/target/release/setpoint-guard`
(the bash fallback is `src/guard/claude-quality-guard.sh`):

```bash
setpoint-guard skip compact_max    # leave compaction alone
setpoint-guard unskip compact_max  # re-enable
setpoint-guard reset               # clear all skips
setpoint-guard status              # current state (same schema as `setpoint guard status`)
setpoint-guard config              # list all categories with [ON]/[OFF]
```

Background on why the guard exists:
[anthropics/claude-code#41477](https://github.com/anthropics/claude-code/issues/41477),
[#42796](https://github.com/anthropics/claude-code/issues/42796),
[#28941](https://github.com/anthropics/claude-code/issues/28941).

## Opus 4.7 compatibility

Claude Opus 4.7 (released 2026-04-16) introduced breaking API changes that intersect with the guard:

- `thinking: {type: "enabled", budget_tokens: N}` returns 400 — Opus 4.7 requires `thinking: {type: "adaptive"}`. The `thinking` category pinned `tengu_crystal_beam.budgetTokens=128000`, which the CLI relayed onto the wire. **`scripts/install-guard.sh` now auto-creates `thinking.skip` on fresh installs** so Opus 4.7 users are safe by default. Opus 4.6 users can re-enable with `setpoint-guard unskip thinking`.
- `temperature`, `top_p`, `top_k` also 400 on Opus 4.7. These are serialized from CLI runtime state — not GrowthBook — so the file-watcher guard has no handle on them. An optional mitmproxy addon at [`tools/mitm/`](tools/mitm/README.md) rewrites outbound request bodies to strip them on Opus 4.7 requests. The addon is **opt-in**; the file-watcher stays the primary control plane.

## Anomaly detection

Eleven rules run inline with every render cycle. Critical alerts override the advisor line; all alerts append to `~/.claude/plugins/claude-hud/anomaly-log.jsonl`.

| Alert | Trigger | Severity |
|---|---|---|
| Token spike | >50K output in a single turn | warn |
| Runaway agent | Agent-spawn count exceeds threshold | critical |
| Context thrashing | Compaction fires >N times per session | warn |
| Stale session | >4 hours without compaction or `/clear` | warn |
| GrowthBook escalation | Guard activations >20/hour | warn |
| Background drain | Cowork / CCD / chrome-native-host / Desktop agents | critical/warn |
| Context pressure | >85% used, no compaction | warn |
| MCP failure streak | Same MCP fails 3+ times consecutively | warn |
| Read:Edit ratio | `reads < 1.0 × edits` on Opus sessions | warn |
| Session efficiency | Low output-to-consumed ratio | info |
| Tool diversity | Session stuck on one tool class | info |

## Color and glyph policy

| Env | Effect |
|---|---|
| `SETPOINT_PALETTE=rag` *(default)* | Vivid green / yellow / red discrete state colors |
| `SETPOINT_PALETTE=cividis` | Colorblind-safe blue→teal→yellow (muted) |
| `SETPOINT_NERD=1` | Nerd Font glyphs |
| `SETPOINT_PLAIN=1` | ASCII only (CI, ssh without fonts) |
| `NO_COLOR=1` / `FORCE_COLOR=0` | Honoured per no-color.org / npm conventions |

Terminal capability is auto-detected (truecolor / ansi256 / ansi16 / none) with graceful degrade. Run `setpoint demo` to see every mode back-to-back in your terminal.

## Multi-session correctness

Every per-session cache file, history entry, debounce marker, and RTK snapshot is keyed by `session_id`. Running three Claude Code sessions in parallel gives three independent HUDs, each showing only its own burn rate, tokens, cache hit, and duration. The Env line surfaces `⧉N sessions` when the account's rate-limit quota is being shared.

## Architecture

```
Claude Code ──stdin JSON──→  setpoint (one-shot)  ──→  8 lines to stdout
                                    │ reads
                                    ▼
                            ~/.claude/plugins/claude-hud/
                                    ▲
  ~/.claude.json ──inotify──→ quality guard (Rust binary, <5ms; bash fallback)
                                    │ logs → /tmp/claude-quality-guard.log
                                    ▼
                            analytics daemon (60s poll) · health timer (daily)
```

The HUD renderer is a one-shot command. Background services run independently as systemd user units and communicate only through files.

## Data sources

| Source | Read by |
|---|---|
| stdin JSON | Renderer |
| `~/.claude/settings.json` | Renderer |
| `~/.claude.json` (GrowthBook cache) | Renderer, Guard |
| Session JSONLs | Analytics daemon |
| `~/.claude/plugins/claude-hud/token-stats/<sid>.json` | Renderer |
| `~/.claude/plugins/claude-hud/usage-history.jsonl` | Rate projector |
| `/tmp/claude-quality-guard.log` | Renderer + `guard status` |

## Related tools

| Project | Overlap |
|---|---|
| [ryoppippi/ccusage](https://github.com/ryoppippi/ccusage) | Complementary. Retrospective JSONL analyzer; run both. |
| [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) | Display-only statusLine with powerline themes. |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | External burn-rate monitor in its own window. |
| [Haleclipse/CCometixLine](https://github.com/Haleclipse/CCometixLine) | Rust statusLine. |

`setpoint`'s differentiator is the inotify feedback loop — it actively re-applies reverted `tengu_*` overrides in real time.

## Requirements

- Node.js ≥ 18 (ESM, `Intl.Segmenter`)
- Linux with systemd (for background services)
- `cargo` (Rust toolchain) for the fast guard binary — optional; falls back to
  a bash + `inotifywait` impl when missing (`inotify-tools` package required
  in that case)

## Testing

```bash
npm test        # 358 tests, Node's built-in test runner, zero deps
npm run health  # run the health auditor once
npm run advisor # run the daily advisor once
```

Smoke test:

```bash
echo '{"session_id":"dev","model":{"id":"claude-opus-4-7"},"context_window":{"context_window_size":200000,"used_percentage":48,"current_usage":{"input_tokens":42000,"output_tokens":9500}},"rate_limits":{"five_hour":{"used_percentage":62},"seven_day":{"used_percentage":38}}}' | setpoint
```

## License

[MIT](LICENSE)
