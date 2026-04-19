#!/bin/bash
# Install the analytics daemon as a systemd user service
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service file
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/analytics-daemon.service" \
  > "$SERVICE_DIR/claude-hud-analytics.service"

systemctl --user daemon-reload
systemctl --user enable claude-hud-analytics.service
systemctl --user start claude-hud-analytics.service

echo "Analytics daemon installed and started"
systemctl --user status claude-hud-analytics.service --no-pager
