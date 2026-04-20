//! Override application — reads ~/.claude.json, mutates only the keys we
//! own, writes back atomically. Every per-category rule lives here so the
//! watcher and `apply` CLI share a single code path.
//!
//! CRITICAL: the `truncation` rule sets EVERY pewter_kestrel subkey, not
//! just `.global`. The bash impl set only `.global` and per-tool defaults
//! silently overrode it (Bash=30000, Grep=20000 in production cache). The
//! per-tool list is sourced from the live cache as of Apr 2026; if a new
//! tool key appears server-side, add it here.

use serde_json::{json, Value};
use std::path::Path;

use crate::paths::write_atomic;

/// Per-tool subkeys for tengu_pewter_kestrel. Sourced from live cache.
const PEWTER_KESTREL_TOOLS: &[&str] = &[
    "global",
    "Bash",
    "PowerShell",
    "Grep",
    "Snip",
    "StrReplaceBasedEditTool",
    "BashSearchTool",
];

const TRUNCATION_TARGET: i64 = 500_000;
const MAX_TOKENS_TARGET: i64 = 128_000;
const REFRESH_TTL_TARGET: i64 = 8760;
const THINKING_BUDGET_TARGET: i64 = 128_000;
const COMPACT_MAX_TARGET: i64 = 200_000;
const COMPACT_INIT_TARGET: i64 = 500_000;

#[derive(Debug, Default)]
pub struct Report {
    /// Flat-dotted flag names that were rewritten this pass.
    pub changed: Vec<String>,
}

/// Read ~/.claude.json, apply overrides for the given active categories,
/// write back atomically iff anything changed. Empty `active` is a no-op.
pub fn apply_all(claude_json: &Path, active: &[&str]) -> std::io::Result<Report> {
    if active.is_empty() {
        return Ok(Report::default());
    }

    let mut data: Value = match std::fs::read(claude_json) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e),
    };

    if !data.is_object() {
        data = json!({});
    }

    let mut changed: Vec<String> = Vec::new();

    {
        let obj = data.as_object_mut().unwrap();
        let gb = obj
            .entry("cachedGrowthBookFeatures".to_string())
            .or_insert_with(|| json!({}));
        if !gb.is_object() {
            *gb = json!({});
        }
        apply_growthbook_rules(gb.as_object_mut().unwrap(), active, &mut changed);
    }

    if active.contains(&"bridge") {
        let obj = data.as_object_mut().unwrap();
        let bridge = obj
            .entry("bridge".to_string())
            .or_insert_with(|| json!({}));
        if !bridge.is_object() {
            *bridge = json!({});
        }
        let bobj = bridge.as_object_mut().unwrap();
        if bobj.get("enabled") != Some(&Value::Bool(false)) {
            bobj.insert("enabled".to_string(), Value::Bool(false));
            changed.push("bridge.enabled".into());
        }
    }

    if !changed.is_empty() {
        let bytes = serde_json::to_vec_pretty(&data)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        write_atomic(claude_json, &bytes)?;
    }

    Ok(Report { changed })
}

fn apply_growthbook_rules(
    gb: &mut serde_json::Map<String, Value>,
    active: &[&str],
    changed: &mut Vec<String>,
) {
    if active.contains(&"brevity") {
        set_string(gb, "tengu_swann_brevity", "", changed);
    }

    if active.contains(&"quiet") {
        for flag in ["tengu_sotto_voce", "quiet_fern", "quiet_hollow"] {
            set_bool(gb, flag, false, changed);
        }
    }

    if active.contains(&"summarize") {
        set_bool(gb, "tengu_summarize_tool_results", false, changed);
    }

    if active.contains(&"maxtokens") {
        set_nested_int(gb, "tengu_amber_wren", "maxTokens", MAX_TOKENS_TARGET, changed);
    }

    // CRITICAL per-tool fix — set every subkey, not just .global.
    if active.contains(&"truncation") {
        let entry = gb
            .entry("tengu_pewter_kestrel".to_string())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        let pk = entry.as_object_mut().unwrap();
        for tool in PEWTER_KESTREL_TOOLS {
            let target = Value::from(TRUNCATION_TARGET);
            if pk.get(*tool) != Some(&target) {
                pk.insert((*tool).to_string(), target);
                changed.push(format!("tengu_pewter_kestrel.{tool}"));
            }
        }
    }

    if active.contains(&"refresh_ttl") {
        // Live cache exposes both keys; set both so whichever Claude reads is sane.
        set_int(gb, "tengu_willow_refresh_ttl_hours", REFRESH_TTL_TARGET, changed);
        set_int(gb, "tengu_willow_census_ttl_hours", REFRESH_TTL_TARGET, changed);
    }

    if active.contains(&"mcp_connect") {
        set_bool(gb, "tengu_claudeai_mcp_connectors", false, changed);
    }

    if active.contains(&"grey_step") {
        set_bool(gb, "tengu_grey_step", false, changed);
    }

    if active.contains(&"grey_step2") {
        set_nested_bool(gb, "tengu_grey_step2", "enabled", false, changed);
    }

    if active.contains(&"grey_wool") {
        set_bool(gb, "tengu_grey_wool", false, changed);
    }

    if active.contains(&"thinking") {
        set_nested_int(
            gb,
            "tengu_crystal_beam",
            "budgetTokens",
            THINKING_BUDGET_TARGET,
            changed,
        );
    }

    if active.contains(&"willow_mode") {
        set_string(gb, "tengu_willow_mode", "", changed);
    }

    if active.contains(&"compact_max") {
        set_nested_int(
            gb,
            "tengu_sm_compact_config",
            "maxTokens",
            COMPACT_MAX_TARGET,
            changed,
        );
    }

    if active.contains(&"compact_init") {
        set_nested_int(
            gb,
            "tengu_sm_config",
            "minimumMessageTokensToInit",
            COMPACT_INIT_TARGET,
            changed,
        );
    }

    if active.contains(&"tool_persist") {
        set_bool(gb, "tengu_tool_result_persistence", true, changed);
    }

    if active.contains(&"chomp") {
        set_bool(gb, "tengu_chomp_inflection", true, changed);
    }
}

fn set_bool(
    obj: &mut serde_json::Map<String, Value>,
    key: &str,
    target: bool,
    changed: &mut Vec<String>,
) {
    if obj.get(key) != Some(&Value::Bool(target)) {
        obj.insert(key.to_string(), Value::Bool(target));
        changed.push(key.into());
    }
}

fn set_int(
    obj: &mut serde_json::Map<String, Value>,
    key: &str,
    target: i64,
    changed: &mut Vec<String>,
) {
    let want = Value::from(target);
    if obj.get(key) != Some(&want) {
        obj.insert(key.to_string(), want);
        changed.push(key.into());
    }
}

fn set_string(
    obj: &mut serde_json::Map<String, Value>,
    key: &str,
    target: &str,
    changed: &mut Vec<String>,
) {
    let want = Value::from(target);
    if obj.get(key) != Some(&want) {
        obj.insert(key.to_string(), want);
        changed.push(key.into());
    }
}

fn set_nested_int(
    parent: &mut serde_json::Map<String, Value>,
    parent_key: &str,
    child_key: &str,
    target: i64,
    changed: &mut Vec<String>,
) {
    let entry = parent
        .entry(parent_key.to_string())
        .or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let inner = entry.as_object_mut().unwrap();
    let want = Value::from(target);
    if inner.get(child_key) != Some(&want) {
        inner.insert(child_key.to_string(), want);
        changed.push(format!("{parent_key}.{child_key}"));
    }
}

fn set_nested_bool(
    parent: &mut serde_json::Map<String, Value>,
    parent_key: &str,
    child_key: &str,
    target: bool,
    changed: &mut Vec<String>,
) {
    let entry = parent
        .entry(parent_key.to_string())
        .or_insert_with(|| json!({}));
    if !entry.is_object() {
        *entry = json!({});
    }
    let inner = entry.as_object_mut().unwrap();
    if inner.get(child_key) != Some(&Value::Bool(target)) {
        inner.insert(child_key.to_string(), Value::Bool(target));
        changed.push(format!("{parent_key}.{child_key}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_initial(path: &Path, value: &Value) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(serde_json::to_vec_pretty(value).unwrap().as_slice())
            .unwrap();
    }

    fn read_back(path: &Path) -> Value {
        let bytes = std::fs::read(path).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn truncation_sets_every_per_tool_subkey() {
        let dir = tempdir();
        let path = dir.join("claude.json");
        write_initial(
            &path,
            &json!({
                "cachedGrowthBookFeatures": {
                    "tengu_pewter_kestrel": { "global": 50000, "Bash": 30000 }
                }
            }),
        );

        let r = apply_all(&path, &["truncation"]).unwrap();
        let kestrel = read_back(&path)["cachedGrowthBookFeatures"]["tengu_pewter_kestrel"].clone();
        for tool in PEWTER_KESTREL_TOOLS {
            assert_eq!(kestrel[tool], json!(TRUNCATION_TARGET), "tool {tool}");
        }
        // Only the keys that were not already at target should be in `changed`.
        assert!(r.changed.iter().any(|k| k == "tengu_pewter_kestrel.global"));
        assert!(r.changed.iter().any(|k| k == "tengu_pewter_kestrel.Bash"));
    }

    #[test]
    fn no_changes_means_no_write() {
        let dir = tempdir();
        let path = dir.join("claude.json");
        let original = json!({
            "cachedGrowthBookFeatures": { "tengu_swann_brevity": "" }
        });
        write_initial(&path, &original);
        let mtime_before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));

        let r = apply_all(&path, &["brevity"]).unwrap();
        assert!(r.changed.is_empty());
        let mtime_after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(mtime_before, mtime_after, "file must not be rewritten when no-op");
    }

    #[test]
    fn empty_active_is_noop_even_if_file_missing() {
        let dir = tempdir();
        let path = dir.join("does-not-exist.json");
        let r = apply_all(&path, &[]).unwrap();
        assert!(r.changed.is_empty());
        assert!(!path.exists(), "no-op must not create the file");
    }

    #[test]
    fn bridge_lives_outside_growthbook_subtree() {
        let dir = tempdir();
        let path = dir.join("claude.json");
        write_initial(&path, &json!({}));

        let r = apply_all(&path, &["bridge"]).unwrap();
        assert!(r.changed.iter().any(|k| k == "bridge.enabled"));
        let v = read_back(&path);
        assert_eq!(v["bridge"]["enabled"], json!(false));
    }

    fn tempdir() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "setpoint-guard-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}
