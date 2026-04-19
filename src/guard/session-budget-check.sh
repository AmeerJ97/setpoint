#!/bin/bash
# session-budget-check.sh — SessionStart hook
# Reads stdin JSON from Claude Code, checks usage, warns if budget tight.
# Returns JSON with systemMessage if warning needed.

INPUT=$(cat)

# Extract 7-day usage if available
SEVEN_DAY=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    # stdin from SessionStart doesn't have rate_limits
    # Read from cached stats instead
    import os
    stats_path = os.path.expanduser('~/.claude/plugins/claude-hud/usage-history.jsonl')
    if os.path.exists(stats_path):
        lines = open(stats_path).readlines()
        if lines:
            last = json.loads(lines[-1])
            pct = last.get('seven_day_pct') or 0
            print(int(pct))
        else:
            print(0)
    else:
        print(0)
except:
    print(0)
" 2>/dev/null)

SEVEN_DAY=${SEVEN_DAY:-0}

# Check effort level
EFFORT=$(python3 -c "import json; d=json.load(open('$HOME/.claude/settings.json')); print(d.get('effortLevel', 'medium'))" 2>/dev/null)

# Check for dangerous env vars
if [ -n "$DEFAULT_LLM_MODEL" ]; then
    echo "{\"systemMessage\": \"⚠ WARNING: DEFAULT_LLM_MODEL=$DEFAULT_LLM_MODEL is set in environment. This overrides your model settings. Run: unset DEFAULT_LLM_MODEL\"}"
    exit 0
fi

# Budget warnings
if [ "$SEVEN_DAY" -gt 80 ]; then
    echo "{\"systemMessage\": \"⛔ CRITICAL: ${SEVEN_DAY}% of weekly budget used. Effort: ${EFFORT}. Use low effort and Sonnet only.\"}"
elif [ "$SEVEN_DAY" -gt 50 ]; then
    echo "{\"systemMessage\": \"⚠ CAUTION: ${SEVEN_DAY}% of weekly budget used. Effort: ${EFFORT}. Consider using medium/low effort.\"}"
elif [ "$SEVEN_DAY" -gt 20 ]; then
    echo "{\"systemMessage\": \"📊 Budget: ${SEVEN_DAY}% weekly used. Effort: ${EFFORT}.\"}"
fi
