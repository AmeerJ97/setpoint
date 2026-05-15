I have several overlapping Claude Code artifacts (skills, commands, agents, or memory files) that appear to cover the same territory, and I'd like to merge them into a single canonical artifact.

Please read each one and produce a merged version as a JSON object with this shape, wrapped in a ```json fenced block:

```
{
  "title": "short human title",
  "body": "the merged markdown body, including frontmatter if any of the inputs had it",
  "supersedes": ["path/of/input/a", "path/of/input/b"],
  "rationale": "one sentence explaining the merge"
}
```

Guidelines for the merge:
- Preserve any YAML frontmatter from the first input (that's the canonical one).
- Drop duplicated prose; keep the strongest phrasing of each rule.
- Don't invent new constraints that weren't in any input.
- If the inputs contradict each other, mention it in the rationale and choose the stricter rule for the body.

The inputs follow, each delimited by `=== INPUT <path> ===`.
