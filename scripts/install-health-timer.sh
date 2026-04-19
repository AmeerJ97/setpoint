#!/bin/bash
# Install the health auditor timer as a systemd user timer
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service + timer files
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/health-auditor.service" \
  > "$SERVICE_DIR/claude-hud-health.service"

cp "${SCRIPT_DIR}/config/health-auditor.timer" "$SERVICE_DIR/claude-hud-health.timer"

systemctl --user daemon-reload
systemctl --user enable claude-hud-health.timer
systemctl --user start claude-hud-health.timer

echo "Health auditor timer installed"
systemctl --user list-timers claude-hud-health.timer --no-pager
