#!/bin/bash
# Enable the Opus 4.7 context-milestone effort auto-swap controller.
#
# This is opt-in on purpose — the controller writes
# `~/.claude/settings.json` (with a daily backup) to switch effort
# between `xhigh`, `high`, and `medium` based on live context %,
# burn rate, and read:edit ratio. It only acts on Opus 4.7 sessions
# and debounces with a 10-minute cooldown + 5% context-delta guard.
#
# Uninstall with `claude-ops auto-effort off` (or just delete the
# sentinel file at ~/.claude/plugins/claude-ops/auto-effort.enabled).

set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SENTINEL="${CLAUDE_DIR}/plugins/claude-ops/auto-effort.enabled"

if [ -f "$SENTINEL" ]; then
  echo "auto-effort already enabled (sentinel: $SENTINEL)"
  exit 0
fi

mkdir -p "$(dirname "$SENTINEL")"
date -u +%FT%TZ > "$SENTINEL"
echo "auto-effort: ENABLED"
echo "  sentinel:  $SENTINEL"
echo "  status:    claude-ops auto-effort status"
echo "  disable:   claude-ops auto-effort off"
