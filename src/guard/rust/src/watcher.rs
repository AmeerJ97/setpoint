//! Inotify-based watcher. Wakes on any modify/move/create event affecting
//! ~/.claude.json, the plugin dir (skip-file mutations), or settings.json
//! files (per research brief §4.4 — settings.json overrides can shadow
//! flags too). Each wake-up reads the file, applies overrides, logs, and
//! consults the backoff tracker before re-firing on the same flag.
//!
//! We deliberately do NOT debounce in time — `notify` already coalesces
//! kernel events and our `apply_all` is a no-op when nothing changed
//! (cheap, single-pass JSON parse). Adding artificial sleeps would increase
//! the worst-case latency past the <150ms SLA we promised.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{Event, EventKind, RecursiveMode, Watcher};

use crate::backoff::Backoff;
use crate::categories;
use crate::log;
use crate::overrides;
use crate::paths::Paths;

pub fn run(p: &Paths) -> Result<(), String> {
    if p.disabled_flag.exists() {
        eprintln!("[guard] Disabled flag at {:?}; exiting cleanly.", p.disabled_flag);
        return Ok(());
    }

    // First-pass apply — covers the common case where the daemon is starting
    // after Claude Code already wrote a fresh cache.
    apply_and_log(p, &mut Backoff::new())?;

    let active = categories::active(p);
    eprintln!(
        "[guard] Watching {:?} ({}/{} categories active)",
        p.claude_json,
        active.len(),
        categories::all().len()
    );

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("watcher init: {e}"))?;

    // Watch ~/.claude.json itself if present, otherwise its parent dir so
    // we still catch the first write.
    if p.claude_json.exists() {
        watcher
            .watch(&p.claude_json, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch claude.json: {e}"))?;
    } else {
        let parent = p.claude_json.parent().unwrap_or(&p.home);
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(|e| format!("watch home: {e}"))?;
    }

    // Plugin dir for skip/disable mutations.
    if p.plugin_dir.exists() {
        let _ = watcher.watch(&p.plugin_dir, RecursiveMode::NonRecursive);
    }

    // Optional: settings.json files (if present) per research brief §4.4.
    let user_settings = p.home.join(".claude").join("settings.json");
    if user_settings.exists() {
        let _ = watcher.watch(&user_settings, RecursiveMode::NonRecursive);
    }
    let project_settings = std::env::current_dir()
        .ok()
        .map(|d| d.join(".claude").join("settings.json"));
    if let Some(ps) = &project_settings {
        if ps.exists() {
            let _ = watcher.watch(ps, RecursiveMode::NonRecursive);
        }
    }

    let mut backoff = Backoff::new();

    loop {
        // Block on the channel; the kernel event drives us, no polling.
        let evt = match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(e)) => Some(e),
            Ok(Err(e)) => {
                eprintln!("[guard] watcher error: {e}");
                None
            }
            Err(mpsc::RecvTimeoutError::Timeout) => None,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("watcher channel closed".into());
            }
        };

        if p.disabled_flag.exists() {
            eprintln!("[guard] Disabled flag detected; exiting watch loop.");
            return Ok(());
        }

        if !is_relevant(evt.as_ref()) {
            continue;
        }

        // Drain any backed-up events to coalesce bursts (Claude Code often
        // writes ~/.claude.json multiple times back-to-back during a turn).
        while let Ok(_) = rx.try_recv() {}

        if let Err(e) = apply_and_log(p, &mut backoff) {
            eprintln!("[guard] apply failed: {e}");
        }
    }
}

fn is_relevant(evt: Option<&Event>) -> bool {
    match evt {
        None => true, // periodic timeout — re-check just in case
        Some(e) => matches!(
            e.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ),
    }
}

fn apply_and_log(p: &Paths, backoff: &mut Backoff) -> Result<(), String> {
    let now = Instant::now();
    let raw_active = categories::active(p);
    // Filter out suspended categories so a storm doesn't keep ping-ponging.
    let active: Vec<&'static str> = raw_active
        .into_iter()
        .filter(|c| !backoff.is_suspended(c, now))
        .collect();

    let report = overrides::apply_all(&p.claude_json, &active)
        .map_err(|e| format!("apply: {e}"))?;
    if report.changed.is_empty() {
        return Ok(());
    }
    log::write(&p.log_file, &report)?;

    // Storm detection per dotted flag → suspend the owning category.
    for flag in &report.changed {
        if let Some(storm) = backoff.record(flag, now) {
            let cat = category_for_flag(&storm.key);
            eprintln!(
                "[guard] revert storm: {} ({} reverts in 60s) — suspending category {} for 5min",
                storm.key, storm.recent_count, cat
            );
            backoff.suspend(cat, now);
        }
    }

    Ok(())
}

/// Map a dotted flag name to the category that owns it. Stays in lockstep
/// with `overrides::apply_growthbook_rules` — if you add a new flag there,
/// add it here too.
fn category_for_flag(flag: &str) -> &'static str {
    let head = flag.split('.').next().unwrap_or(flag);
    match head {
        "tengu_swann_brevity" => "brevity",
        "tengu_sotto_voce" | "quiet_fern" | "quiet_hollow" => "quiet",
        "tengu_summarize_tool_results" => "summarize",
        "tengu_amber_wren" => "maxtokens",
        "tengu_pewter_kestrel" => "truncation",
        "tengu_willow_refresh_ttl_hours" | "tengu_willow_census_ttl_hours" => "refresh_ttl",
        "tengu_claudeai_mcp_connectors" => "mcp_connect",
        "bridge" => "bridge",
        "tengu_grey_step" => "grey_step",
        "tengu_grey_step2" => "grey_step2",
        "tengu_grey_wool" => "grey_wool",
        "tengu_crystal_beam" => "thinking",
        "tengu_willow_mode" => "willow_mode",
        "tengu_sm_compact_config" => "compact_max",
        "tengu_sm_config" => "compact_init",
        "tengu_tool_result_persistence" => "tool_persist",
        "tengu_chomp_inflection" => "chomp",
        _ => "unknown",
    }
}

// We can't unit-test the inotify loop without spawning a thread and racing
// the kernel; stick to pure helper tests here.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_mapping_covers_every_known_flag() {
        for (flag, expected) in [
            ("tengu_swann_brevity", "brevity"),
            ("tengu_pewter_kestrel.global", "truncation"),
            ("tengu_pewter_kestrel.Bash", "truncation"),
            ("bridge.enabled", "bridge"),
            ("tengu_willow_census_ttl_hours", "refresh_ttl"),
        ] {
            assert_eq!(category_for_flag(flag), expected, "flag={flag}");
        }
    }

    #[test]
    fn unknown_flag_maps_to_unknown() {
        assert_eq!(category_for_flag("tengu_marble_whisper"), "unknown");
    }
}
