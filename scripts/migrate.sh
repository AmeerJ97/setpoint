#!/bin/bash
# Migrate from old HUD to claude-ops by updating settings.json statusLine
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
NEW_CMD="node ${SCRIPT_DIR}/src/cli/index.js"

mkdir -p "$CLAUDE_DIR"

# Backup
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"
fi

# Update the statusLine command
python3 -c "
import json, sys
from pathlib import Path
p = Path('$SETTINGS')
if p.exists():
    with p.open('r') as f:
        settings = json.load(f)
else:
    settings = {}
sl = settings.get('statusLine', {})
old_cmd = sl.get('command', '')
sl['type'] = 'command'
sl['command'] = '$NEW_CMD'
sl['padding'] = sl.get('padding', 0)
settings['statusLine'] = sl
with p.open('w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
if old_cmd:
    print(f'Migrated: {old_cmd} -> $NEW_CMD')
else:
    print(f'Set statusLine: $NEW_CMD')
"
