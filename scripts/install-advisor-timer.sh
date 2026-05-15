#!/bin/bash
# Install the daily advisor timer as a systemd user timer
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DIR="${CLAUDE_OPS_SYSTEMD_USER_DIR:-$SERVICE_DIR}"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service + timer files
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/daily-advisor.service" \
  > "$SERVICE_DIR/claude-ops-advisor.service"

cp "${SCRIPT_DIR}/config/daily-advisor.timer" "$SERVICE_DIR/claude-ops-advisor.timer"

if [ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]; then
  systemctl --user daemon-reload
  systemctl --user enable claude-ops-advisor.timer
  systemctl --user start claude-ops-advisor.timer
  echo "Daily advisor timer installed and started"
  systemctl --user list-timers claude-ops-advisor.timer --no-pager
else
  echo "Daily advisor timer installed (systemctl skipped)"
fi
