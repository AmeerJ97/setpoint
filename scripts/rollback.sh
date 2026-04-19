#!/bin/bash
# Rollback claude-hud — restores settings.json and stops all HUD services
set -e

SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: $SETTINGS not found"
  exit 1
fi

# Stop and disable all claude-hud services (best effort)
echo "Stopping services..."
systemctl --user stop claude-hud-analytics.service 2>/dev/null || true
systemctl --user stop claude-quality-guard.service 2>/dev/null || true
systemctl --user disable claude-hud-analytics.service 2>/dev/null || true
systemctl --user disable claude-quality-guard.service 2>/dev/null || true
systemctl --user disable claude-hud-health.timer 2>/dev/null || true
systemctl --user disable claude-hud-advisor.timer 2>/dev/null || true

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
