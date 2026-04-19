# Changelog

## 1.0.0

Initial release.

### HUD
- Eight-line statusLine for Claude Code: model, context, usage, tokens, env, MCPs, guard, advisor.
- Combined current+projected gauges on the Usage and Advisor lines.
- Per-turn output sparkline on the Tokens line.
- Octant-bar (1/8-cell precision) progress on the Context line.
- Two-column layout on terminals ≥100 chars wide.

### Color + glyph policy
- Oklab-interpolated gradients. Default palette is cividis (colorblind-safe); opt-in `SETPOINT_PALETTE=rag` for classic green/yellow/red.
- Six-step capability detection honours `NO_COLOR`, `SETPOINT_PLAIN`, TTY status, `COLORTERM`, `TERM`; degrades truecolor → 256 → 16 → none.
- Glyph policy: Unicode BMP by default, `SETPOINT_PLAIN=1` for ASCII, `SETPOINT_NERD=1` for Nerd Font icons.

### Quality guard
- bash + Python daemon watches `~/.claude.json` via `inotifywait`.
- Seventeen `tengu_*` / `bridge` feature-flag categories held at configured setpoints.
- Sub-500 ms re-application on GrowthBook revert.
- Per-category `skip`/`unskip`/`reset` CLI.
- Disabled by default — explicit opt-in.

### Analytics + anomaly + health
- Analytics daemon: 60 s poll of active session JSONL, sigmoid-blended rate projection, per-session cache partitioning.
- Eleven anomaly rules: token spike, runaway agent, context thrash, stale session, GrowthBook escalation, background drain, context pressure, MCP failure, read:edit ratio, session efficiency, tool diversity.
- Health auditor (daily timer): session bloat, orphan files, config drift, CLAUDE.md accumulation, disk usage, flag coverage.
- Daily advisor: top consumers, weekly trend, effort matrix, RTK efficiency.

### Multi-session correctness
- Every cache file, history entry, debounce marker, and RTK snapshot keyed by `session_id`. Concurrent Claude Code sessions never see each other's metrics. The HUD surfaces `⧉N sessions` on the Env line when more than one session is active.

### CLI
- `setpoint` — render HUD from stdin.
- `setpoint guard status [--json]` — three-column drilldown of the 17 categories with per-flag expected-vs-actual values. Exits non-zero on drift.
- `setpoint demo` — render the HUD in every color and glyph mode back-to-back.
- `setpoint health` / `setpoint advisor` — run the corresponding report once.

### Infrastructure
- Zero runtime dependencies. Node.js ≥ 18, Linux only.
- 249 tests on Node 18/20/22.
- Install scripts for systemd user services (guard, analytics, health, advisor) with relocatable `{{INSTALL_DIR}}` templating.
