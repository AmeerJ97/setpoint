#!/bin/bash
# Install the analytics collector as an on-demand systemd user service
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DIR="${CLAUDE_OPS_SYSTEMD_USER_DIR:-$SERVICE_DIR}"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service file
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/analytics-daemon.service" \
  > "$SERVICE_DIR/claude-ops-analytics.service"

if [ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]; then
  systemctl --user daemon-reload
  systemctl --user disable --now claude-ops-analytics.service >/dev/null 2>&1 || true
  echo "Analytics collector installed (on-demand; Claude Code HUD starts it while sessions are active)"
  systemctl --user show claude-ops-analytics.service -p LoadState -p ActiveState -p UnitFileState --no-pager
else
  echo "Analytics collector unit installed (systemctl skipped)"
fi
