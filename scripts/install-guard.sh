#!/bin/bash
# Install the quality guard as a systemd user service
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

# Ensure the guard script is executable. /bin/bash is used in ExecStart so
# this is belt-and-suspenders, but keeps manual `./claude-quality-guard.sh`
# invocation working.
chmod +x "${SCRIPT_DIR}/src/guard/claude-quality-guard.sh"

# Substitute template variable and install service file
sed "s|{{INSTALL_DIR}}|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/config/claude-quality-guard.service" \
  > "$SERVICE_DIR/claude-quality-guard.service"

systemctl --user daemon-reload
systemctl --user enable claude-quality-guard.service

echo "Quality guard installed."
echo ""
echo "  ⚠  DISABLED by default for safety."
echo ""
echo "  To activate, run one of:"
echo "    systemctl --user start claude-quality-guard"
echo "    ${SCRIPT_DIR}/src/guard/claude-quality-guard.sh enable"
echo ""
echo "  To check status:"
echo "    ${SCRIPT_DIR}/src/guard/claude-quality-guard.sh status"
