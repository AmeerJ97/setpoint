#!/usr/bin/env bats
#
# Regression tests for the bash fallback quality guard.
# Run: bats src/guard/guard-bash.bats
#
# Covers the two fallback-only bugs fixed alongside these tests:
#  - truncation must set every pewter_kestrel subkey, not just .global
#  - refresh_ttl must set both the `refresh_ttl` and `census_ttl` keys
#
# The script lives under HOME and writes to $HOME/.claude.json, so each
# test points HOME at a fresh tmpdir. That also isolates the $CONFIG_DIR
# (skip files) and the disabled flag from the developer's live install.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../.." && pwd)"
  GUARD="${REPO_ROOT}/src/guard/claude-quality-guard.sh"

  TEST_HOME="$(mktemp -d)"
  export HOME="$TEST_HOME"
  CLAUDE_JSON="${TEST_HOME}/.claude.json"
}

teardown() {
  if [[ -n "${TEST_HOME:-}" && -d "$TEST_HOME" ]]; then
    rm -rf "$TEST_HOME"
  fi
}

# Helper: jq-free JSON read via python (already a guard dependency).
json_get() {
  python3 -c "
import json, sys
with open('$CLAUDE_JSON') as f:
    data = json.load(f)
keys = '$1'.split('.')
cur = data
for k in keys:
    cur = cur.get(k, None) if isinstance(cur, dict) else None
    if cur is None:
        break
print(json.dumps(cur))
"
}

@test "apply creates ~/.claude.json when missing" {
  [[ ! -e "$CLAUDE_JSON" ]]
  run "$GUARD" apply
  [ "$status" -eq 0 ]
  [ -f "$CLAUDE_JSON" ]
}

@test "truncation sets every pewter_kestrel subkey (Rust parity)" {
  cat > "$CLAUDE_JSON" <<'JSON'
{
  "cachedGrowthBookFeatures": {
    "tengu_pewter_kestrel": { "global": 30000, "Bash": 30000, "Grep": 20000 }
  }
}
JSON

  run "$GUARD" apply
  [ "$status" -eq 0 ]

  for tool in global Bash PowerShell Grep Snip StrReplaceBasedEditTool BashSearchTool; do
    value="$(json_get "cachedGrowthBookFeatures.tengu_pewter_kestrel.${tool}")"
    [ "$value" = "500000" ] || {
      echo "expected 500000 for ${tool}, got: ${value}"
      return 1
    }
  done
}

@test "refresh_ttl sets both the refresh and census ttl keys" {
  echo '{}' > "$CLAUDE_JSON"

  run "$GUARD" apply
  [ "$status" -eq 0 ]

  refresh_val="$(json_get "cachedGrowthBookFeatures.tengu_willow_refresh_ttl_hours")"
  census_val="$(json_get "cachedGrowthBookFeatures.tengu_willow_census_ttl_hours")"
  [ "$refresh_val" = "8760" ]
  [ "$census_val" = "8760" ]
}

@test "skipping truncation disables the subkey loop" {
  mkdir -p "$TEST_HOME/.claude/plugins/claude-hud/guard-config"
  touch "$TEST_HOME/.claude/plugins/claude-hud/guard-config/truncation.skip"
  echo '{}' > "$CLAUDE_JSON"

  run "$GUARD" apply
  [ "$status" -eq 0 ]

  # Nothing should have written tengu_pewter_kestrel.
  pk="$(json_get "cachedGrowthBookFeatures.tengu_pewter_kestrel")"
  [ "$pk" = "null" ]
}

@test "apply is idempotent — re-running produces no changes" {
  echo '{}' > "$CLAUDE_JSON"
  "$GUARD" apply >/dev/null
  before_mtime="$(stat -c %Y "$CLAUDE_JSON")"
  # sleep is needed because mtime resolution is seconds on ext4.
  sleep 1
  "$GUARD" apply >/dev/null
  after_mtime="$(stat -c %Y "$CLAUDE_JSON")"
  # The bash guard currently always writes (unlike the Rust impl). What we
  # care about is that the contents are unchanged on a second pass.
  first="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$CLAUDE_JSON")"
  "$GUARD" apply >/dev/null
  second="$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$CLAUDE_JSON")"
  [ "$first" = "$second" ]
}

@test "all 17 categories are applied end-to-end on a fresh file" {
  echo '{}' > "$CLAUDE_JSON"
  run "$GUARD" apply
  [ "$status" -eq 0 ]

  # Spot-check one flag per category.
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_swann_brevity')" = '""' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_sotto_voce')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_summarize_tool_results')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_amber_wren.maxTokens')" = '128000' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_pewter_kestrel.global')" = '500000' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_willow_refresh_ttl_hours')" = '8760' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_claudeai_mcp_connectors')" = 'false' ]
  [ "$(json_get 'bridge.enabled')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_grey_step')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_grey_step2.enabled')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_grey_wool')" = 'false' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_crystal_beam.budgetTokens')" = '128000' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_willow_mode')" = '""' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_sm_compact_config.maxTokens')" = '200000' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_sm_config.minimumMessageTokensToInit')" = '500000' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_tool_result_persistence')" = 'true' ]
  [ "$(json_get 'cachedGrowthBookFeatures.tengu_chomp_inflection')" = 'true' ]
}
