#!/bin/bash
# Rollback claude-ops — restores settings.json and stops all local services
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
BIN_PATH="${CLAUDE_OPS_BIN_DIR:-$HOME/.local/bin}/claude-ops"
CLI_ENTRY="$SCRIPT_DIR/src/cli/index.js"
OWNED_LAUNCHER_MARKER="claude-ops launcher (owned by claude-ops)"
INSTALL_ROOT="$(cd "$SCRIPT_DIR" && node --input-type=module <<'NODE'
import { resolveInstallTarget } from './src/data/install-target.js';
process.stdout.write(resolveInstallTarget({ env: process.env, currentRepoRoot: process.cwd() }).root);
NODE
)"

if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: $SETTINGS not found"
  exit 1
fi

# Stop and disable all known old and new services (best effort)
echo "Stopping services..."
for unit in \
  claude-ops-analytics.service \
  claude-ops-health.service \
  claude-ops-health.timer \
  claude-ops-advisor.service \
  claude-ops-advisor.timer \
  claude-ops-guard.service \
  claude-hud-analytics.service \
  claude-hud-health.service \
  claude-hud-health.timer \
  claude-hud-advisor.service \
  claude-hud-advisor.timer \
  claude-quality-guard.service
do
  if [ "${CLAUDE_OPS_SKIP_SYSTEMCTL:-0}" != "1" ]; then
    systemctl --user stop "$unit" 2>/dev/null || true
    systemctl --user disable "$unit" 2>/dev/null || true
  fi
done

if [ -L "$BIN_PATH" ] && [ "$(readlink -f "$BIN_PATH")" = "$CLI_ENTRY" ]; then
  rm -f "$BIN_PATH"
  echo "Removed owned symlink: $BIN_PATH"
elif [ -f "$BIN_PATH" ] && grep -q "$OWNED_LAUNCHER_MARKER" "$BIN_PATH"; then
  rm -f "$BIN_PATH"
  echo "Removed owned launcher: $BIN_PATH"
fi

case "$INSTALL_ROOT" in
  ""|"/"|"$HOME"|"$HOME/"|"$SCRIPT_DIR") ;;
  *)
    if [ -d "$INSTALL_ROOT" ] && [ -f "$INSTALL_ROOT/package.json" ] && [ -f "$INSTALL_ROOT/src/cli/index.js" ]; then
      rm -rf "$INSTALL_ROOT"
      echo "Removed managed install root: $INSTALL_ROOT"
    fi
    ;;
esac

# Find the most recent backup
LATEST_BAK=$(ls -t "${SETTINGS}".bak.* 2>/dev/null | head -1)

if [ -z "$LATEST_BAK" ]; then
  echo "No backup found. Cannot rollback settings."
  exit 1
fi

cp "$LATEST_BAK" "$SETTINGS"
echo "Restored from: $LATEST_BAK"
echo "Current statusLine:"
python3 -c "
import json
with open('$SETTINGS') as f:
    s = json.load(f)
print(json.dumps(s.get('statusLine', {}), indent=2))
"
