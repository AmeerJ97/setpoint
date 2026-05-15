#!/bin/bash
# One-command installer for claude-ops.
#
# Usage: bash scripts/install.sh
#
# What it does (in order):
#   1. checks Node.js
#   2. copies the package to the discovered managed install root
#   3. repairs local wiring             ~/.local/bin launcher + statusLine + units
#      (via installed claude-ops repair --apply; keeps timestamped .bak files)
#   4. repairs docs-backed guard controls in settings.env
#   5. installs the analytics collector systemd user service
#   6. installs + starts the health     systemd user timer
#   7. installs the advisor             systemd user timer
#   8. installs the quality guard unit  and applies the selected guard mode
#
# The guard unit is installed but NOT enabled or started by default — enabling
# enforcement is an explicit act. The analytics collector is on-demand: Claude
# Code statusLine renders wake it, and it exits after idle time.
#
# Re-running this script is idempotent; it will refresh the installed copy,
# rewrite the launcher, update settings.json, and reload systemd unit files.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SCRIPT_DIR="$SOURCE_DIR"
cd "$SOURCE_DIR"

say() { printf '\033[36m▶\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

install_package_copy() {
  INSTALL_DIR="$(node --input-type=module <<'NODE'
import { resolveInstallTarget } from './src/data/install-target.js';
process.stdout.write(resolveInstallTarget({ env: process.env, currentRepoRoot: process.cwd() }).root);
NODE
)"
  mkdir -p "$INSTALL_DIR"
  local install_physical
  install_physical="$(cd "$INSTALL_DIR" && pwd -P)"

  if [[ "$SOURCE_DIR" == "$install_physical" ]]; then
    SCRIPT_DIR="$install_physical"
    return
  fi

  case "$install_physical" in
    ""|"/"|"$HOME"|"$HOME/"|"$SOURCE_DIR") die "unsafe CLAUDE_OPS_INSTALL_DIR: $INSTALL_DIR" ;;
  esac

  local tmp tarball
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  tarball="$(npm pack --silent --pack-destination "$tmp")"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  tar -xzf "$tmp/$tarball" -C "$tmp"
  cp -a "$tmp/package/." "$INSTALL_DIR/"
  SCRIPT_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
}

# --- 1. prerequisites -----------------------------------------------------
say "1/8  checking node ($(node --version 2>/dev/null || echo 'node missing'))"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required (Node 18+)." >&2
  exit 1
fi

say "2/8  installing package copy (no symlink)"
install_package_copy
ok "installed files → $SCRIPT_DIR"

say "3/8  repairing CLI launcher, statusLine, migration state, and user units"
node "${SCRIPT_DIR}/src/cli/index.js" repair --apply >/dev/null
ok "claude-ops launcher → ${CLAUDE_OPS_BIN_DIR:-${HOME}/.local/bin}/claude-ops"

# --- 4. docs-backed guard controls ----------------------------------------
say "4/8  repairing docs-backed guard controls in settings.env"
node "${SCRIPT_DIR}/src/cli/index.js" guard repair --apply >/dev/null
ok "documented guard controls aligned"

# --- 5. analytics collector ----------------------------------------------
say "5/8  installing analytics collector (on-demand, idle-exit)"
bash "${SCRIPT_DIR}/scripts/install-analytics.sh" >/dev/null
if [[ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" == "1" ]]; then
  ok "claude-ops-analytics unit installed (systemctl skipped)"
else
  ok "claude-ops-analytics installed (starts from Claude Code HUD)"
fi

# --- 6. health timer ------------------------------------------------------
say "6/8  installing daily health auditor timer"
bash "${SCRIPT_DIR}/scripts/install-health-timer.sh" >/dev/null
if [[ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" == "1" ]]; then
  ok "claude-ops-health.timer installed (systemctl skipped)"
else
  ok "claude-ops-health.timer active"
fi

# --- 7. advisor timer -----------------------------------------------------
say "7/8  installing daily advisor timer"
bash "${SCRIPT_DIR}/scripts/install-advisor-timer.sh" >/dev/null
if [[ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" == "1" ]]; then
  ok "claude-ops-advisor.timer installed (systemctl skipped)"
else
  ok "claude-ops-advisor.timer loaded"
fi

# --- 8. guard (installed, not started) -----------------------------------
say "8/8  installing quality guard (inotify + 17 overrides)"
bash "${SCRIPT_DIR}/scripts/install-guard.sh" >/dev/null
GUARD_MODE="${CLAUDE_OPS_GUARD_MODE:-audit}"
node "${SCRIPT_DIR}/src/cli/index.js" guard mode "${GUARD_MODE}" >/dev/null
if command -v cargo >/dev/null 2>&1; then
  ok "guard installed (Rust binary)"
else
  warn "cargo not found — installed bash fallback (slower, ~100ms re-apply)"
fi
echo
say "guard mode configured: ${GUARD_MODE}"
if [[ "${GUARD_MODE}" == "audit" ]]; then
  echo "    switch later: claude-ops guard mode enforce"
elif [[ "${GUARD_MODE}" == "disabled" ]]; then
  echo "    switch later: claude-ops guard mode audit"
else
  echo "    switch later: claude-ops guard mode audit"
fi
echo

# --- summary --------------------------------------------------------------
say "validating installation with claude-ops doctor + guard validate --strict"
if ! node "${SCRIPT_DIR}/src/cli/index.js" doctor >/tmp/claude-ops-install-doctor.txt 2>&1; then
  cat /tmp/claude-ops-install-doctor.txt >&2
  echo >&2
  echo "ERROR: install completed with repairable drift. Run: claude-ops doctor --json" >&2
  exit 1
fi
if ! node "${SCRIPT_DIR}/src/cli/index.js" guard validate --strict >/tmp/claude-ops-install-guard.txt 2>&1; then
  cat /tmp/claude-ops-install-guard.txt >&2
  echo >&2
  echo "ERROR: install completed but documented guard controls still drift. Run: claude-ops guard validate --json" >&2
  exit 1
fi
ok "doctor clean"

ok "claude-ops installed. Restart Claude Code; the HUD appears above the prompt."
echo
echo "Verify:"
echo "    claude-ops --help               # command overview"
echo "    claude-ops guard status         # 17-category inventory"
if [[ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]]; then
  echo "    claude-ops analytics status"
fi
echo
echo "Optional opt-in extras (safe to run any time):"
echo "    bash scripts/install-auto-effort.sh   # Opus 4.7 effort auto-swap"
echo "    bash scripts/install-hooks.sh         # 8 behavioral guidance hooks"
echo
echo "Uninstall with: bash scripts/rollback.sh"
