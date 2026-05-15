#!/bin/bash
# Install Claude Ops behavioral hook library into ~/.claude/settings.json.
#
# Registers the `claude-ops-guidance` hook on `UserPromptSubmit` — on
# every user message, the hook evaluator checks the current session's
# metrics against the 8 starter hooks in config/hooks/, and if any
# trigger fires (past its cooldown, highest priority), emits a short
# targeted hookSpecificOutput.additionalContext the model sees before it responds.
#
# Fully opt-in. Set CLAUDE_OPS_INSTALL_PRECOMPACT_HOOK=1 to also register
# a PreCompact hook for snapshot capture. Uninstall by removing entries under
# `settings.json -> hooks.UserPromptSubmit[].hooks`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK_CMD="node ${SCRIPT_DIR}/src/hooks/emit.js"

if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: $SETTINGS not found — run scripts/install.sh first"
  exit 1
fi

cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"

python3 - "$SETTINGS" "$HOOK_CMD" <<'PY'
import json, os, sys
path, cmd = sys.argv[1], sys.argv[2]
with open(path) as f:
    s = json.load(f)

s.setdefault('hooks', {})

def upsert(event, *, async_hook=False):
    groups = s['hooks'].setdefault(event, [])
    entry = None
    for e in groups:
        for h in e.get('hooks', []):
            if h.get('command', '').endswith('src/hooks/emit.js'):
                entry = h
                break
        if entry:
            break

    if entry:
        entry['command'] = cmd
        entry['timeout'] = 5
        if async_hook:
            entry['async'] = True
        print(f"updated existing Claude Ops hook on {event} → {cmd}")
    else:
        groups.append({
            'matcher': '*',
            'hooks': [{
            'type': 'command',
            'command': cmd,
            'timeout': 5,
            **({'async': True} if async_hook else {}),
            }],
        })
        print(f"installed Claude Ops hook on {event} → {cmd}")

upsert('UserPromptSubmit')
if os.environ.get('CLAUDE_OPS_INSTALL_PRECOMPACT_HOOK') == '1':
    upsert('PreCompact')

with open(path, 'w') as f:
    json.dump(s, f, indent=2)
PY

echo "Hook library installed."
echo "  hook catalog: ${SCRIPT_DIR}/config/hooks/"
echo "  audit log:    ${CLAUDE_DIR}/plugins/claude-ops/hook-log.jsonl"
echo
echo "Disable by editing $SETTINGS and removing the entry under"
echo "hooks.UserPromptSubmit (or restore the .bak.* backup)."
