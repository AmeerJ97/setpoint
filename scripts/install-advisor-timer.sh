#!/bin/bash
# Install the daily advisor timer as a systemd user timer
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

# Substitute template variable and install service + timer files
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/daily-advisor.service" \
  > "$SERVICE_DIR/claude-hud-advisor.service"

cp "${SCRIPT_DIR}/config/daily-advisor.timer" "$SERVICE_DIR/claude-hud-advisor.timer"

systemctl --user daemon-reload
systemctl --user enable claude-hud-advisor.timer
systemctl --user start claude-hud-advisor.timer

echo "Daily advisor timer installed"
systemctl --user list-timers claude-hud-advisor.timer --no-pager
