//! setpoint-guard — Rust replacement for src/guard/claude-quality-guard.sh.
//!
//! Watches ~/.claude.json via inotify (notify crate) and re-applies the
//! tengu_* GrowthBook overrides whenever the cache is mutated. Improvements
//! over the bash version:
//!
//! * <50 ms cold latency vs ~100 ms for bash → python interpreter spin-up
//! * Per-tool pewter_kestrel fix — sets every subkey, not just .global.
//!   The bash impl set only .global=500000; per-tool defaults overrode it
//!   silently (verified Apr 2026: live cache had Bash=30000, Grep=20000).
//! * Atomic write via write-temp + rename so a partially-written ~/.claude.json
//!   can't be observed by Claude Code mid-update.
//! * Exponential backoff on revert storms — ≥3 reverts of the same flag in
//!   60 s suspends that category for 5 min and logs an anomaly. Prevents
//!   the guard fighting Anthropic in a tight loop.

use std::process::ExitCode;

mod backoff;
mod categories;
mod log;
mod overrides;
mod paths;
mod watcher;

fn print_usage(arg0: &str) {
    eprintln!("setpoint-guard 2.0 — quality guard for Claude Code");
    eprintln!();
    eprintln!("Usage: {arg0} <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  watch              Run the inotify watcher (foreground)");
    eprintln!("  apply              Apply overrides once and exit");
    eprintln!("  status             Print category states + recent activations");
    eprintln!("  config             List all categories with [ON]/[OFF]");
    eprintln!("  skip <cat>         Disable a category (creates .skip file)");
    eprintln!("  unskip <cat>       Re-enable a category");
    eprintln!("  reset              Remove every .skip file");
    eprintln!("  enable             Remove the disabled flag");
    eprintln!("  disable            Set the disabled flag (and stop watch)");
}

fn run(args: Vec<String>) -> Result<(), String> {
    let arg0 = args.first().cloned().unwrap_or_else(|| "setpoint-guard".into());
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let p = paths::Paths::new();
    p.ensure_dirs().map_err(|e| format!("ensure dirs: {e}"))?;

    match cmd {
        "watch" | "_watch" => watcher::run(&p),
        "apply" => {
            let active = categories::active(&p);
            let report = overrides::apply_all(&p.claude_json, &active)
                .map_err(|e| format!("apply: {e}"))?;
            if !report.changed.is_empty() {
                log::write(&p.log_file, &report)?;
            }
            println!("applied: {} change(s)", report.changed.len());
            Ok(())
        }
        "status" => cmd_status(&p),
        "config" => cmd_config(&p),
        "skip" => cmd_skip(&p, args.get(2).cloned()),
        "unskip" => cmd_unskip(&p, args.get(2).cloned()),
        "reset" => cmd_reset(&p),
        "enable" => cmd_enable(&p),
        "disable" => cmd_disable(&p),
        "" | "help" | "--help" | "-h" => { print_usage(&arg0); Ok(()) }
        unknown => {
            print_usage(&arg0);
            Err(format!("unknown command: {unknown}"))
        }
    }
}

fn cmd_status(p: &paths::Paths) -> Result<(), String> {
    let disabled = p.disabled_flag.exists();
    println!("Status: {}", if disabled { "DISABLED" } else { "ENABLED" });

    let cats = categories::all();
    let mut active = 0usize;
    let mut skipped: Vec<&str> = Vec::new();
    for c in cats {
        if categories::is_skipped(p, c.name) { skipped.push(c.name); }
        else { active += 1; }
    }
    println!("Categories: {} active, {} skipped (of {})",
        active, skipped.len(), cats.len());
    if !skipped.is_empty() {
        println!("Skipped:");
        for s in &skipped { println!("  - {s}"); }
    }

    if let Ok(s) = std::fs::read_to_string(&p.log_file) {
        let recent: Vec<_> = s.lines().rev().take(5).collect();
        if !recent.is_empty() {
            println!("Recent activations:");
            for line in recent.iter().rev() { println!("  {line}"); }
        }
    }
    Ok(())
}

fn cmd_config(p: &paths::Paths) -> Result<(), String> {
    println!("Quality Guard Categories:\n");
    let cats = categories::all();
    let mut active = 0usize;
    let mut skipped = 0usize;
    for c in cats {
        let on = !categories::is_skipped(p, c.name);
        if on { active += 1; } else { skipped += 1; }
        println!("  [{}] {:<13} — {}",
            if on { "ON " } else { "OFF" }, c.name, c.description);
    }
    println!();
    println!("{} active, {} skipped (of {} total)", active, skipped, cats.len());
    Ok(())
}

fn cmd_skip(p: &paths::Paths, cat: Option<String>) -> Result<(), String> {
    let name = cat.ok_or("skip requires <category>")?;
    if !categories::is_known(&name) { return Err(format!("unknown category: {name}")); }
    let path = p.config_dir.join(format!("{name}.skip"));
    std::fs::write(&path, b"").map_err(|e| format!("touch {path:?}: {e}"))?;
    println!("Category '{name}' skipped.");
    Ok(())
}

fn cmd_unskip(p: &paths::Paths, cat: Option<String>) -> Result<(), String> {
    let name = cat.ok_or("unskip requires <category>")?;
    if !categories::is_known(&name) { return Err(format!("unknown category: {name}")); }
    let path = p.config_dir.join(format!("{name}.skip"));
    let _ = std::fs::remove_file(&path);
    println!("Category '{name}' re-enabled.");
    Ok(())
}

fn cmd_reset(p: &paths::Paths) -> Result<(), String> {
    let mut count = 0;
    if let Ok(rd) = std::fs::read_dir(&p.config_dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("skip") {
                if std::fs::remove_file(&path).is_ok() { count += 1; }
            }
        }
    }
    println!("Removed {count} skip file(s).");
    Ok(())
}

fn cmd_enable(p: &paths::Paths) -> Result<(), String> {
    let _ = std::fs::remove_file(&p.disabled_flag);
    println!("Quality guard ENABLED.");
    Ok(())
}

fn cmd_disable(p: &paths::Paths) -> Result<(), String> {
    std::fs::write(&p.disabled_flag, b"")
        .map_err(|e| format!("write disabled flag: {e}"))?;
    println!("Quality guard DISABLED.");
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
