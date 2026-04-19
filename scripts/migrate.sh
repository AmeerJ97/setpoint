#!/bin/bash
# Migrate from old HUD to claude-hud by updating settings.json statusLine
set -e

SETTINGS="$HOME/.claude/settings.json"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NEW_CMD="node ${SCRIPT_DIR}/src/hud/renderer.js"

if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: $SETTINGS not found"
  exit 1
fi

# Backup
cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"

# Update the statusLine command
python3 -c "
import json, sys
with open('$SETTINGS', 'r') as f:
    settings = json.load(f)
sl = settings.get('statusLine', {})
old_cmd = sl.get('command', '')
sl['type'] = 'command'
sl['command'] = '$NEW_CMD'
settings['statusLine'] = sl
with open('$SETTINGS', 'w') as f:
    json.dump(settings, f, indent=2)
if old_cmd:
    print(f'Migrated: {old_cmd} -> $NEW_CMD')
else:
    print(f'Set statusLine: $NEW_CMD')
"
