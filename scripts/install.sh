#!/bin/bash
# One-command installer for setpoint.
#
# Usage: bash scripts/install.sh
#
# What it does (in order):
#   1. `npm link`                       — exposes `setpoint` on PATH
#   2. wires the statusLine into        ~/.claude/settings.json
#      (via scripts/migrate.sh; keeps a timestamped .bak)
#   3. installs + starts the analytics  systemd user service
#   4. installs + starts the health     systemd user timer
#   5. installs the advisor             systemd user timer
#   6. installs the quality guard       (Rust if cargo present, bash fallback)
#
# The guard is installed but NOT started by default — starting it is an
# explicit act (`systemctl --user start claude-quality-guard`). Every other
# service is safe-by-default to autostart and can be stopped later with
# `bash scripts/rollback.sh`.
#
# Re-running this script is idempotent; it will re-link, re-write the
# settings.json entry, and reload systemd unit files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

say() { printf '\033[36m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }

# --- 1. link the CLI ------------------------------------------------------
say "1/6  linking setpoint CLI ($(node --version 2>/dev/null || echo 'node missing'))"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required (Node 20+)." >&2
  exit 1
fi
npm link >/dev/null
ok "setpoint → $(command -v setpoint)"

# --- 2. statusLine wiring -------------------------------------------------
say "2/6  wiring statusLine into ~/.claude/settings.json"
bash "${SCRIPT_DIR}/scripts/migrate.sh"

# --- 3. analytics daemon --------------------------------------------------
say "3/6  installing analytics daemon (15s poll)"
bash "${SCRIPT_DIR}/scripts/install-analytics.sh" >/dev/null
ok "claude-hud-analytics running"

# --- 4. health timer ------------------------------------------------------
say "4/6  installing daily health auditor timer"
bash "${SCRIPT_DIR}/scripts/install-health-timer.sh" >/dev/null
ok "claude-hud-health.timer active"

# --- 5. advisor timer -----------------------------------------------------
say "5/6  installing daily advisor timer"
bash "${SCRIPT_DIR}/scripts/install-advisor-timer.sh" >/dev/null
ok "daily-advisor.timer loaded"

# --- 6. guard (installed, not started) -----------------------------------
say "6/6  installing quality guard (inotify + 17 overrides)"
bash "${SCRIPT_DIR}/scripts/install-guard.sh" >/dev/null
if command -v cargo >/dev/null 2>&1; then
  ok "guard installed (Rust binary)"
else
  warn "cargo not found — installed bash fallback (slower, ~100ms re-apply)"
fi
echo
say "guard is DISABLED by default. Start it when ready:"
echo "    systemctl --user start claude-quality-guard"
echo

# --- summary --------------------------------------------------------------
ok "setpoint installed. Restart Claude Code; the HUD appears above the prompt."
echo
echo "Verify:"
echo "    setpoint < /dev/null          # dummy render"
echo "    setpoint guard status         # 17-category inventory"
echo "    systemctl --user status claude-hud-analytics"
echo
echo "Uninstall with: bash scripts/rollback.sh"
