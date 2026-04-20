#!/bin/bash
# Build the Rust setpoint-guard binary.
#
# Output: $REPO/src/guard/rust/target/release/setpoint-guard
# Falls back gracefully (exit 0, prints a notice) if cargo isn't installed,
# so the wider install-guard.sh can switch to the bash impl without aborting.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_DIR="${SCRIPT_DIR}/src/guard/rust"

if ! command -v cargo &>/dev/null; then
  echo "[build-guard] cargo not found in PATH — skipping Rust build."
  echo "[build-guard] install-guard.sh will fall back to the bash impl."
  exit 0
fi

echo "[build-guard] Building setpoint-guard (release profile)..."
( cd "$RUST_DIR" && cargo build --release --quiet )

BIN="${RUST_DIR}/target/release/setpoint-guard"
if [[ ! -x "$BIN" ]]; then
  echo "[build-guard] ERROR: build succeeded but binary not found at $BIN"
  exit 1
fi

SIZE=$(du -h "$BIN" | awk '{print $1}')
echo "[build-guard] OK — ${BIN} (${SIZE})"
