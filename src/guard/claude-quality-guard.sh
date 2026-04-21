#!/bin/bash
#
# Claude Quality Guard — Watches ~/.claude.json via inotifywait and re-applies
# quality overrides within <500ms of any GrowthBook revert.
#
# Default state: DISABLED. Run `systemctl --user start claude-quality-guard` to activate.
#
# Usage: claude-quality-guard.sh {start|stop|status|enable|disable|config|skip|unskip|reset}

set -euo pipefail

CLAUDE_JSON="$HOME/.claude.json"
LOG_FILE="/tmp/claude-quality-guard.log"
PLUGIN_DIR="$HOME/.claude/plugins/claude-hud"
DISABLED_FLAG="$PLUGIN_DIR/guard-disabled"
PID_FILE="$PLUGIN_DIR/guard.pid"
CONFIG_DIR="$PLUGIN_DIR/guard-config"

# Ensure directories exist
mkdir -p "$PLUGIN_DIR" "$CONFIG_DIR"

# ---------------------------------------------------------------------------
# Category definitions (name:description)
# Each category maps to one or more GrowthBook feature flag overrides.
# A category is skipped if $CONFIG_DIR/<name>.skip exists.
# ---------------------------------------------------------------------------
declare -A CATEGORIES=(
  [brevity]="Prevents brevity enforcer from shortening responses"
  [quiet]="Disables quiet modes that suppress tool output"
  [summarize]="Prevents tool result compression/summarization"
  [maxtokens]="Sets max output tokens to 128K"
  [truncation]="Sets tool output truncation cap to 500K (every per-tool subkey)"
  [refresh_ttl]="Extends refresh TTL to 1 year"
  [mcp_connect]="Disables cloud MCP connectors"
  [bridge]="Disables Claude Desktop bridge"
  [grey_step]="Disables effort reducer v1"
  [grey_step2]="Disables medium effort override"
  [grey_wool]="Disables effort reducer v3"
  [thinking]="Restores thinking budget to 128K (Opus 4.6 and earlier only; skip on Opus 4.7 — API rejects thinking.budget_tokens)"
  [willow_mode]="Disables capability downgrade mode"
  [compact_max]="Sets compaction survival to 200K tokens"
  [compact_init]="Sets compaction trigger to 500K tokens"
  [tool_persist]="Preserves tool results across compaction"
  [chomp]="Enables adaptive processing"
)

TOTAL_CATEGORIES=${#CATEGORIES[@]}

# ---------------------------------------------------------------------------
# Helper: check if a category is skipped
# ---------------------------------------------------------------------------
is_skipped() {
  local cat="$1"
  [[ -f "$CONFIG_DIR/$cat.skip" ]]
}

# ---------------------------------------------------------------------------
# Build the list of active categories for the Python script
# ---------------------------------------------------------------------------
build_active_list() {
  local active=()
  for cat in "${!CATEGORIES[@]}"; do
    if ! is_skipped "$cat"; then
      active+=("$cat")
    fi
  done
  printf '%s\n' "${active[@]}"
}

# ---------------------------------------------------------------------------
# Override application — single Python invocation for all active categories
# ---------------------------------------------------------------------------
apply_overrides() {
  local active_list
  active_list=$(build_active_list | sort)

  if [[ -z "$active_list" ]]; then
    return 0
  fi

  local tmpfile
  tmpfile=$(mktemp)

  # Build a comma-separated list of active categories for Python
  local active_csv
  active_csv=$(echo "$active_list" | paste -sd, -)

  python3 -c '
import json, sys, os

path = os.path.expanduser("~/.claude.json")
if not os.path.exists(path):
    data = {}
else:
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except json.JSONDecodeError:
        data = {}

if "cachedGrowthBookFeatures" not in data:
    data["cachedGrowthBookFeatures"] = {}
gb = data["cachedGrowthBookFeatures"]

active = sys.argv[1].split(",") if sys.argv[1] else []
changed = []

# --- brevity: tengu_swann_brevity → "" ---
if "brevity" in active:
    if gb.get("tengu_swann_brevity") != "":
        gb["tengu_swann_brevity"] = ""
        changed.append("tengu_swann_brevity")

# --- quiet: tengu_sotto_voce, quiet_fern, quiet_hollow → false ---
if "quiet" in active:
    for flag in ["tengu_sotto_voce", "quiet_fern", "quiet_hollow"]:
        if gb.get(flag) is not False:
            gb[flag] = False
            changed.append(flag)

# --- summarize: tengu_summarize_tool_results → false ---
if "summarize" in active:
    if gb.get("tengu_summarize_tool_results") is not False:
        gb["tengu_summarize_tool_results"] = False
        changed.append("tengu_summarize_tool_results")

# --- maxtokens: tengu_amber_wren.maxTokens → 128000 ---
if "maxtokens" in active:
    if gb.get("tengu_amber_wren", {}).get("maxTokens") != 128000:
        if "tengu_amber_wren" not in gb or not isinstance(gb["tengu_amber_wren"], dict):
            gb["tengu_amber_wren"] = {}
        gb["tengu_amber_wren"]["maxTokens"] = 128000
        changed.append("tengu_amber_wren.maxTokens")

# --- truncation: tengu_pewter_kestrel.{all subkeys} → 500000 ---
# Must mirror Rust overrides.rs PEWTER_KESTREL_TOOLS. Setting only .global
# silently loses to per-tool defaults (Bash=30000, Grep=20000) that revert
# independently.
if "truncation" in active:
    pewter_tools = ["global", "Bash", "PowerShell", "Grep", "Snip",
                    "StrReplaceBasedEditTool", "BashSearchTool"]
    if "tengu_pewter_kestrel" not in gb or not isinstance(gb["tengu_pewter_kestrel"], dict):
        gb["tengu_pewter_kestrel"] = {}
    pk = gb["tengu_pewter_kestrel"]
    for tool in pewter_tools:
        if pk.get(tool) != 500000:
            pk[tool] = 500000
            changed.append("tengu_pewter_kestrel." + tool)

# --- refresh_ttl: both ttl keys → 8760 (live cache exposes both) ---
if "refresh_ttl" in active:
    for key in ["tengu_willow_refresh_ttl_hours", "tengu_willow_census_ttl_hours"]:
        if gb.get(key) != 8760:
            gb[key] = 8760
            changed.append(key)

# --- mcp_connect: tengu_claudeai_mcp_connectors → false ---
if "mcp_connect" in active:
    if gb.get("tengu_claudeai_mcp_connectors") is not False:
        gb["tengu_claudeai_mcp_connectors"] = False
        changed.append("tengu_claudeai_mcp_connectors")

# --- bridge: bridge.enabled → false ---
if "bridge" in active:
    if "bridge" not in data:
        data["bridge"] = {}
    if data["bridge"].get("enabled") is not False:
        data["bridge"]["enabled"] = False
        changed.append("bridge.enabled")

# --- grey_step: tengu_grey_step → false ---
if "grey_step" in active:
    if gb.get("tengu_grey_step") is not False:
        gb["tengu_grey_step"] = False
        changed.append("tengu_grey_step")

# --- grey_step2: tengu_grey_step2.enabled → false ---
if "grey_step2" in active:
    if gb.get("tengu_grey_step2", {}).get("enabled") is not False:
        if "tengu_grey_step2" not in gb or not isinstance(gb["tengu_grey_step2"], dict):
            gb["tengu_grey_step2"] = {}
        gb["tengu_grey_step2"]["enabled"] = False
        changed.append("tengu_grey_step2.enabled")

# --- grey_wool: tengu_grey_wool → false ---
if "grey_wool" in active:
    if gb.get("tengu_grey_wool") is not False:
        gb["tengu_grey_wool"] = False
        changed.append("tengu_grey_wool")

# --- thinking: tengu_crystal_beam.budgetTokens → 128000 ---
if "thinking" in active:
    if gb.get("tengu_crystal_beam", {}).get("budgetTokens") != 128000:
        if "tengu_crystal_beam" not in gb or not isinstance(gb["tengu_crystal_beam"], dict):
            gb["tengu_crystal_beam"] = {}
        gb["tengu_crystal_beam"]["budgetTokens"] = 128000
        changed.append("tengu_crystal_beam.budgetTokens")

# --- willow_mode: tengu_willow_mode → "" ---
if "willow_mode" in active:
    if gb.get("tengu_willow_mode") != "":
        gb["tengu_willow_mode"] = ""
        changed.append("tengu_willow_mode")

# --- compact_max: tengu_sm_compact_config.maxTokens → 200000 ---
if "compact_max" in active:
    if gb.get("tengu_sm_compact_config", {}).get("maxTokens") != 200000:
        if "tengu_sm_compact_config" not in gb or not isinstance(gb["tengu_sm_compact_config"], dict):
            gb["tengu_sm_compact_config"] = {}
        gb["tengu_sm_compact_config"]["maxTokens"] = 200000
        changed.append("tengu_sm_compact_config.maxTokens")

# --- compact_init: tengu_sm_config.minimumMessageTokensToInit → 500000 ---
if "compact_init" in active:
    if gb.get("tengu_sm_config", {}).get("minimumMessageTokensToInit") != 500000:
        if "tengu_sm_config" not in gb or not isinstance(gb["tengu_sm_config"], dict):
            gb["tengu_sm_config"] = {}
        gb["tengu_sm_config"]["minimumMessageTokensToInit"] = 500000
        changed.append("tengu_sm_config.minimumMessageTokensToInit")

# --- tool_persist: tengu_tool_result_persistence → true ---
if "tool_persist" in active:
    if gb.get("tengu_tool_result_persistence") is not True:
        gb["tengu_tool_result_persistence"] = True
        changed.append("tengu_tool_result_persistence")

# --- chomp: tengu_chomp_inflection → true ---
if "chomp" in active:
    if gb.get("tengu_chomp_inflection") is not True:
        gb["tengu_chomp_inflection"] = True
        changed.append("tengu_chomp_inflection")

# Write back atomically
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)

if changed:
    print(",".join(changed))
else:
    print("")
' "$active_csv" > "$tmpfile"

  local flags
  flags=$(cat "$tmpfile")
  rm -f "$tmpfile"

  if [[ -n "$flags" ]]; then
    local timestamp
    timestamp=$(date -Is)
    local count
    count=$(echo "$flags" | tr ',' '\n' | grep -c '^tengu_\|^bridge\.')
    echo "${timestamp} Re-applied: $flags (${count} overrides)" >> "$LOG_FILE"
  fi
}

# ---------------------------------------------------------------------------
# Watch loop — runs continuously while guard is active
# ---------------------------------------------------------------------------
watch_loop() {
  if [[ -f "$DISABLED_FLAG" ]]; then
    echo "[guard] Disabled flag found at $DISABLED_FLAG"
    echo "[guard] Remove it to enable, or run: $(basename "$0") enable"
    # Exit successfully so systemd doesn't restart-loop a deliberately disabled guard.
    return 0
  fi

  if ! command -v inotifywait &>/dev/null; then
    echo "[guard] ERROR: inotifywait not found. Install inotify-tools."
    return 1
  fi

  apply_overrides

  local active_count skipped_count
  active_count=$(build_active_list | grep -c '^' || true)
  skipped_count=$((TOTAL_CATEGORIES - active_count))
  echo "[guard] Watching $CLAUDE_JSON ($active_count/$TOTAL_CATEGORIES categories active, $skipped_count skipped)..."

  while true; do
    if [[ -f "$DISABLED_FLAG" ]]; then
      echo "[guard] Disabled flag detected; exiting watch loop."
      return 0
    fi

    # Watch both ~/.claude.json and the plugin dir so changes to skip/unskip/disable
    # take effect immediately.
    inotifywait -q \
      -e modify,attrib,move_self \
      -e create,delete,move \
      "$CLAUDE_JSON" "$PLUGIN_DIR" 2>/dev/null || true

    if [[ -f "$DISABLED_FLAG" ]]; then
      echo "[guard] Disabled flag detected; exiting watch loop."
      return 0
    fi

    sleep 0.1
    apply_overrides
  done
}

# ---------------------------------------------------------------------------
# CLI: config — list all categories with [ON]/[OFF] status
# ---------------------------------------------------------------------------
cmd_config() {
  local active=0 skipped=0
  echo "Quality Guard Categories:"
  echo ""
  for cat in $(echo "${!CATEGORIES[@]}" | tr ' ' '\n' | sort); do
    local status
    if is_skipped "$cat"; then
      status="OFF"
      ((skipped++)) || true
    else
      status="ON "
      ((active++)) || true
    fi
    printf "  [%s] %-12s — %s\n" "$status" "$cat" "${CATEGORIES[$cat]}"
  done
  echo ""
  echo "$active active, $skipped skipped (of $TOTAL_CATEGORIES total)"
}

# ---------------------------------------------------------------------------
# CLI: skip <category> — disable a category
# ---------------------------------------------------------------------------
cmd_skip() {
  local cat="${1:-}"
  if [[ -z "$cat" ]]; then
    echo "Usage: $(basename "$0") skip <category>"
    echo "Run '$(basename "$0") config' to see available categories."
    exit 1
  fi

  if [[ -z "${CATEGORIES[$cat]+x}" ]]; then
    echo "Unknown category: $cat"
    echo "Run '$(basename "$0") config' to see available categories."
    exit 1
  fi

  touch "$CONFIG_DIR/$cat.skip"
  echo "Category '$cat' skipped. Re-run '$(basename "$0") start' if guard is running."
}

# ---------------------------------------------------------------------------
# CLI: unskip <category> — re-enable a category
# ---------------------------------------------------------------------------
cmd_unskip() {
  local cat="${1:-}"
  if [[ -z "$cat" ]]; then
    echo "Usage: $(basename "$0") unskip <category>"
    echo "Run '$(basename "$0") config' to see available categories."
    exit 1
  fi

  if [[ -z "${CATEGORIES[$cat]+x}" ]]; then
    echo "Unknown category: $cat"
    echo "Run '$(basename "$0") config' to see available categories."
    exit 1
  fi

  rm -f "$CONFIG_DIR/$cat.skip"
  echo "Category '$cat' re-enabled. Re-run '$(basename "$0") start' if guard is running."
}

# ---------------------------------------------------------------------------
# CLI: reset — remove all .skip files (restore defaults)
# ---------------------------------------------------------------------------
cmd_reset() {
  local count=0
  for f in "$CONFIG_DIR"/*.skip; do
    [[ -f "$f" ]] || continue
    rm -f "$f"
    ((count++)) || true
  done
  echo "Removed $count skip file(s). All $TOTAL_CATEGORIES categories are now active."
}

# ---------------------------------------------------------------------------
# CLI: start/stop/status/enable/disable (existing)
# ---------------------------------------------------------------------------
cmd_start() {
  if [[ -f "$DISABLED_FLAG" ]]; then
    echo "Quality guard is DISABLED. Run '$(basename "$0") enable' first."
    exit 1
  fi
  cmd_stop 2>/dev/null || true
  nohup "$0" _watch > /dev/null 2>&1 &
  echo $! > "$PID_FILE"
  echo "Quality guard started (PID $(cat "$PID_FILE"))"
}

cmd_stop() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Quality guard stopped"
  else
    echo "Quality guard not running"
  fi
}

cmd_status() {
  if [[ -f "$DISABLED_FLAG" ]]; then
    echo "Status: DISABLED"
  else
    echo "Status: ENABLED"
  fi

  local active=0 skipped=0
  for cat in "${!CATEGORIES[@]}"; do
    if is_skipped "$cat"; then
      ((skipped++)) || true
    else
      ((active++)) || true
    fi
  done

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "Process: running (PID $pid)"
    else
      echo "Process: not running (stale PID file)"
      rm -f "$PID_FILE"
    fi
  else
    echo "Process: not running"
  fi

  echo "Categories: $active active, $skipped skipped (of $TOTAL_CATEGORIES)"

  if [[ $skipped -gt 0 ]]; then
    echo "Skipped:"
    for cat in $(echo "${!CATEGORIES[@]}" | tr ' ' '\n' | sort); do
      if is_skipped "$cat"; then
        echo "  - $cat"
      fi
    done
  fi

  if [[ -f "$LOG_FILE" ]]; then
    echo "Recent activations:"
    tail -n 5 "$LOG_FILE" | sed 's/^/  /'
  fi
}

cmd_apply() {
  apply_overrides
}

cmd_enable() {
  rm -f "$DISABLED_FLAG"
  echo "Quality guard ENABLED. Run '$(basename "$0") start' or 'systemctl --user start claude-quality-guard' to activate."
}

cmd_disable() {
  touch "$DISABLED_FLAG"
  cmd_stop 2>/dev/null || true
  echo "Quality guard DISABLED and stopped."
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
case "${1:-}" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  status)     cmd_status ;;
  enable)     cmd_enable ;;
  disable)    cmd_disable ;;
  config)     cmd_config ;;
  skip)       cmd_skip "${2:-}" ;;
  unskip)     cmd_unskip "${2:-}" ;;
  reset)      cmd_reset ;;
  apply)      cmd_apply ;;
  _watch)     watch_loop ;;
  *)
    echo "Usage: $(basename "$0") {start|stop|status|enable|disable|apply|config|skip|unskip|reset}"
    echo ""
    echo "Claude Quality Guard — protects ~/.claude.json quality overrides"
    echo ""
    echo "Commands:"
    echo "  start           Start the guard (requires enable first)"
    echo "  stop            Stop the guard"
    echo "  status          Show guard status, categories, and recent activations"
    echo "  enable          Remove the disabled flag (allows start)"
    echo "  disable         Set the disabled flag and stop the guard"
    echo "  config          List all categories with [ON]/[OFF] status"
    echo "  skip <cat>      Disable a category (create .skip file)"
    echo "  unskip <cat>    Re-enable a category (remove .skip file)"
    echo "  reset           Remove all .skip files (restore defaults)"
    echo "  apply           Apply overrides once and exit (useful for tests)"
    echo ""
    echo "Categories (all ON by default when guard is enabled):"
    for cat in $(echo "${!CATEGORIES[@]}" | tr ' ' '\n' | sort); do
      printf "  %-12s — %s\n" "$cat" "${CATEGORIES[$cat]}"
    done
    exit 1
    ;;
esac
