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
    Category { name: "refresh_ttl",  description: "Audits prompt cache enablement and documented 1-hour TTL request" },
    Category { name: "mcp_connect",  description: "Audits Claude.ai MCP server policy and Vertex tool-search compatibility" },
    Category { name: "bridge",       description: "Tracks internal Claude Desktop bridge disable flag" },
    Category { name: "grey_step",    description: "Tracks internal effort reducer v1 flag" },
    Category { name: "grey_step2",   description: "Tracks internal medium effort override flag" },
    Category { name: "grey_wool",    description: "Tracks internal effort reducer v3 flag" },
    Category { name: "thinking",     description: "Restores thinking budget to 128K (Opus 4.6 and earlier only; skip on Opus 4.7 — API rejects thinking.budget_tokens)" },
    Category { name: "willow_mode",  description: "Tracks internal capability downgrade-mode flag" },
    Category { name: "compact_max",  description: "Audits documented compaction controls and internal compact max target" },
    Category { name: "compact_init", description: "Audits documented compaction controls and internal trigger target" },
    Category { name: "tool_persist", description: "Tracks internal tool-result persistence flag" },
    Category { name: "chomp",        description: "Tracks internal adaptive-processing flag" },
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
