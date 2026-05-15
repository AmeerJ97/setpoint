#!/bin/bash
# Install the health auditor timer as a systemd user timer
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DIR="${CLAUDE_OPS_SYSTEMD_USER_DIR:-$SERVICE_DIR}"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service + timer files
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/health-auditor.service" \
  > "$SERVICE_DIR/claude-ops-health.service"

cp "${SCRIPT_DIR}/config/health-auditor.timer" "$SERVICE_DIR/claude-ops-health.timer"

if [ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]; then
  systemctl --user daemon-reload
  systemctl --user enable claude-ops-health.timer
  systemctl --user start claude-ops-health.timer
  echo "Health auditor timer installed and started"
  systemctl --user list-timers claude-ops-health.timer --no-pager
else
  echo "Health auditor timer installed (systemctl skipped)"
fi
