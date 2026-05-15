#!/bin/bash
# Install the quality guard as a systemd user service.
#
# Prefers the Rust binary (built by build-guard.sh) for <50ms inotify latency.
# Falls back to the legacy bash impl when cargo isn't available — the bash
# impl is functionally equivalent but ~100ms slower per event due to a
# python interpreter spin-up on every revert.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DIR="${CLAUDE_OPS_SYSTEMD_USER_DIR:-$SERVICE_DIR}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGIN_DIR="$CLAUDE_DIR/plugins/claude-ops"
GUARD_CONFIG_DIR="$PLUGIN_DIR/guard-config"
mkdir -p "$SERVICE_DIR"
mkdir -p "$GUARD_CONFIG_DIR"

# Opus 4.7 (released 2026-04-16) rejects thinking.budget_tokens with a 400.
# The `thinking` category pins tengu_crystal_beam.budgetTokens=128000, which
# the CLI relays onto the wire. Auto-skip on fresh installs so Opus 4.7 users
# are safe by default. Opus 4.6 users can re-enable via `guard unskip thinking`.
if [[ ! -e "$GUARD_CONFIG_DIR/thinking.skip" ]]; then
  touch "$GUARD_CONFIG_DIR/thinking.skip"
fi
# Tag the reason so `claude-ops guard status` renders a self-documenting
# "[opus_4_7_incompatible]" alongside the skipped row instead of leaving
# the operator to go spelunking for "why is thinking skipped?".
if [[ ! -e "$GUARD_CONFIG_DIR/thinking.skip.reason" ]]; then
  printf 'opus_4_7_incompatible\n' > "$GUARD_CONFIG_DIR/thinking.skip.reason"
fi

RUST_BIN="${SCRIPT_DIR}/src/guard/rust/target/release/claude-ops-guard"
BASH_IMPL="${SCRIPT_DIR}/src/guard/claude-ops-guard.sh"

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
# template still exists at config/claude-ops-guard.service for manual
# inspection, but we no longer use sed against it because the ExecStart
# line itself is what differs between impls.
cat > "$SERVICE_DIR/claude-ops-guard.service" <<EOF
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

if [[ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]]; then
  systemctl --user daemon-reload
fi

echo "Quality guard installed (impl: ${IMPL_LABEL})."
echo ""
echo "  Default mode is audit. Reconfigure later with:"
echo "    claude-ops guard mode enforce"
echo "    claude-ops guard mode audit"
echo "    claude-ops guard mode disabled"
echo ""
if [[ -x "$RUST_BIN" ]]; then
  echo "  CLI:  ${RUST_BIN} {watch|apply|status|config|skip|unskip|reset|enable|disable}"
else
  echo "  CLI:  ${BASH_IMPL} {start|stop|status|config|skip|unskip|reset|enable|disable}"
fi
echo ""
echo "  To activate immediately, run one of:"
echo "    systemctl --user start claude-ops-guard"
if [[ -x "$RUST_BIN" ]]; then
  echo "    ${RUST_BIN} enable && systemctl --user start claude-ops-guard"
else
  echo "    ${BASH_IMPL} enable && ${BASH_IMPL} start"
fi
