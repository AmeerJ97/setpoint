//! Category catalog. Mirrors the categories listed in
//! config/defaults.json → guard.categories. Kept in lockstep manually
//! because we don't want a JSON read on every cache mutation.

use crate::paths::Paths;

pub struct Category {
    pub name: &'static str,
    pub description: &'static str,
}

const ALL: &[Category] = &[
    Category { name: "brevity",      description: "Prevents brevity enforcer from shortening responses" },
    Category { name: "quiet",        description: "Disables quiet modes that suppress tool output" },
    Category { name: "summarize",    description: "Prevents tool result compression/summarization" },
    Category { name: "maxtokens",    description: "Sets max output tokens to 128K" },
    Category { name: "truncation",   description: "Sets tool output truncation cap to 500K (every per-tool subkey)" },
    Category { name: "refresh_ttl",  description: "Extends refresh TTL to 1 year" },
    Category { name: "mcp_connect",  description: "Disables cloud MCP connectors" },
    Category { name: "bridge",       description: "Disables Claude Desktop bridge" },
    Category { name: "grey_step",    description: "Disables effort reducer v1" },
    Category { name: "grey_step2",   description: "Disables medium effort override" },
    Category { name: "grey_wool",    description: "Disables effort reducer v3" },
    Category { name: "thinking",     description: "Restores thinking budget to 128K (Opus 4.6 and earlier only; skip on Opus 4.7 — API rejects thinking.budget_tokens)" },
    Category { name: "willow_mode",  description: "Disables capability downgrade mode" },
    Category { name: "compact_max",  description: "Sets compaction survival to 200K tokens" },
    Category { name: "compact_init", description: "Sets compaction trigger to 500K tokens" },
    Category { name: "tool_persist", description: "Preserves tool results across compaction" },
    Category { name: "chomp",        description: "Enables adaptive processing" },
];

pub fn all() -> &'static [Category] { ALL }

pub fn is_known(name: &str) -> bool {
    ALL.iter().any(|c| c.name == name)
}

pub fn is_skipped(p: &Paths, name: &str) -> bool {
    p.config_dir.join(format!("{name}.skip")).exists()
}

/// Active category names — those without a `<name>.skip` file present.
pub fn active(p: &Paths) -> Vec<&'static str> {
    ALL.iter()
        .filter(|c| !is_skipped(p, c.name))
        .map(|c| c.name)
        .collect()
}
