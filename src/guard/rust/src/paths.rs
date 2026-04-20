//! Filesystem path resolution. We deliberately don't pull in `dirs` —
//! the only path resolution we need is $HOME, and a single env::var call
//! is cheaper than a transitive dependency tree.

use std::env;
use std::path::{Path, PathBuf};

pub struct Paths {
    pub home: PathBuf,
    pub claude_json: PathBuf,
    pub plugin_dir: PathBuf,
    pub disabled_flag: PathBuf,
    #[allow(dead_code)] // reserved for future PID-file support; bash impl uses it.
    pub pid_file: PathBuf,
    pub config_dir: PathBuf,
    pub log_file: PathBuf,
}

impl Paths {
    pub fn new() -> Self {
        let home = env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"));
        let claude_json = home.join(".claude.json");
        let plugin_dir = home.join(".claude").join("plugins").join("claude-hud");
        Self {
            disabled_flag: plugin_dir.join("guard-disabled"),
            pid_file: plugin_dir.join("guard.pid"),
            config_dir: plugin_dir.join("guard-config"),
            log_file: PathBuf::from("/tmp/claude-quality-guard.log"),
            plugin_dir,
            claude_json,
            home,
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.plugin_dir)?;
        std::fs::create_dir_all(&self.config_dir)?;
        Ok(())
    }
}

/// Atomic write — write to `.tmp-XXX` next to `target`, then rename.
/// Uses the system's atomic rename guarantee. Bytes are flushed before
/// rename so a reader observing the new path sees a complete file.
pub fn write_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let tmp = dir.join(format!(".tmp-guard-{pid}-{nanos}.json"));

    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target)
}
