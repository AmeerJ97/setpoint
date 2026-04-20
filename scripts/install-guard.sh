#!/bin/bash
# Install the quality guard as a systemd user service.
#
# Prefers the Rust binary (built by build-guard.sh) for <50ms inotify latency.
# Falls back to the legacy bash impl when cargo isn't available — the bash
# impl is functionally equivalent but ~100ms slower per event due to a
# python interpreter spin-up on every revert.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

RUST_BIN="${SCRIPT_DIR}/src/guard/rust/target/release/setpoint-guard"
BASH_IMPL="${SCRIPT_DIR}/src/guard/claude-quality-guard.sh"

# Always keep the bash script executable so manual fallback works even when
# the Rust binary is the chosen ExecStart target.
chmod +x "$BASH_IMPL"

# Try the Rust build first. build-guard.sh exits 0 with a notice when cargo
# is missing, so its exit code alone isn't enough — we check for the binary.
"${SCRIPT_DIR}/scripts/build-guard.sh" || true

if [[ -x "$RUST_BIN" ]]; then
  EXEC_LINE="ExecStart=${RUST_BIN} watch"
  IMPL_LABEL="rust"
else
  EXEC_LINE="ExecStart=/bin/bash ${BASH_IMPL} _watch"
  IMPL_LABEL="bash (fallback — install rust toolchain for the faster impl)"
fi

# Generate the unit file with the chosen ExecStart line. The original
# template still exists at config/claude-quality-guard.service for manual
# inspection, but we no longer use sed against it because the ExecStart
# line itself is what differs between impls.
cat > "$SERVICE_DIR/claude-quality-guard.service" <<EOF
[Unit]
Description=Claude Quality Guard (${IMPL_LABEL})
After=network.target

[Service]
Type=simple
${EXEC_LINE}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable claude-quality-guard.service

echo "Quality guard installed (impl: ${IMPL_LABEL})."
echo ""
echo "  ⚠  DISABLED by default for safety."
echo ""
if [[ -x "$RUST_BIN" ]]; then
  echo "  CLI:  ${RUST_BIN} {watch|apply|status|config|skip|unskip|reset|enable|disable}"
else
  echo "  CLI:  ${BASH_IMPL} {start|stop|status|config|skip|unskip|reset|enable|disable}"
fi
echo ""
echo "  To activate, run one of:"
echo "    systemctl --user start claude-quality-guard"
if [[ -x "$RUST_BIN" ]]; then
  echo "    ${RUST_BIN} enable && systemctl --user start claude-quality-guard"
else
  echo "    ${BASH_IMPL} enable && ${BASH_IMPL} start"
fi
