I have a Claude Code memory note and I'd like a second opinion on whether it should be promoted into a reusable artifact (skill / command / agent) or left as memory.

Please read it and respond with a JSON object wrapped in a ```json fenced block, with this shape:

```
{
  "promote_to": "skill" | "command" | "agent" | "none",
  "proposed_name": "kebab-case-name or empty",
  "cleaned_body": "the refined artifact body with appropriate frontmatter for the target kind, or empty string if promote_to=none",
  "replaces": ["path/of/input"],
  "rationale": "one sentence explaining the decision"
}
```

Promotion heuristics you can use:
- **skill** — reusable pattern, checklist, or workflow a future session would benefit from loading.
- **command** — a specific invocable action the user would want to trigger by `/name`.
- **agent** — a role + mandate appropriate for a subagent dispatch.
- **none** — genuinely ephemeral; keep as memory.

When `promote_to` is non-`none`, `cleaned_body` should include the appropriate frontmatter block for that kind and be a fully-formed artifact the user can drop into `~/.claude/<kind>/`.

The memory file follows:
