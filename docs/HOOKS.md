# Behavioral hook library

Claude Ops ships eight opt-in `UserPromptSubmit` hooks that inject short,
targeted `hookSpecificOutput.additionalContext` into the model's context when a
trigger fires. Each hook is **tiny** (≤ ~60 body tokens), gated on
a live session metric, and cooldown-debounced so the same reminder
doesn't fire twice in a short window.

> User directive (verbatim): *"not just say READ — should trigger a
> set of granular detailed instructions and guiding hooks that are
> light on context, e.g. take the idea of a skill, chop it up,
> distill it to basis set of instructions, have them reminded when
> violated OR have FSM-like workflows guiding hooks where they
> instruct it on what phase its at OR having hooks that adversarially
> question it about its task such that it must demonstrate
> understanding if triggered."*

## Enable

```bash
bash scripts/install-hooks.sh
# Disable by editing ~/.claude/settings.json and removing the
# `claude-ops-guidance` entry under hooks.UserPromptSubmit.
```

The default hook mode is advisory. To emit blocking hook output for local
experiments, set `CLAUDE_OPS_HOOK_MODE=blocking`; the installer still leaves the
shim registered as an advisory UserPromptSubmit hook unless you explicitly
configure otherwise.

Optional `PreCompact` snapshot capture can be enabled with:

```bash
CLAUDE_OPS_INSTALL_PRECOMPACT_HOOK=1 bash scripts/install-hooks.sh
CLAUDE_OPS_PRECOMPACT_SNAPSHOTS=1 claude-ops-hook
```

Snapshots are written under `~/.claude/plugins/claude-ops/precompact/` and are
local diagnostic artifacts, not provider telemetry.

## Hook kinds

| Kind          | Purpose                                                         |
|---------------|-----------------------------------------------------------------|
| `reminder`    | Surface a violated invariant when it happens                    |
| `fsm`         | Announce the phase the agent *should* be in, given observed tool usage |
| `adversarial` | Demand the agent demonstrate understanding before proceeding    |

## Starter hooks

| File                              | Kind          | Trigger                                                   |
|-----------------------------------|---------------|-----------------------------------------------------------|
| `read-before-edit.md`             | reminder      | `ratio < 1.5` AND `edits ≥ 3`                             |
| `compact-approaching.md`          | reminder      | `contextPct > 70`                                         |
| `mcp-bloat.md`                    | reminder      | `mcp_loaded ≥ 5` AND `mcp_used ≤ 2`                       |
| `investigate-phase.md`            | fsm           | `reads_this_turn = 0` AND `edits_this_turn ≥ 1`           |
| `plan-phase.md`                   | fsm           | `edits_session ≥ 5` AND `task_updates_session = 0`        |
| `adversarial-why.md`              | adversarial   | `lr_risk > 0.6` (from the LR classifier)                  |
| `backlog-drift.md`                | reminder      | `agent_spawns_session ≥ 3`                                |
| `rate-limit-near.md`              | reminder      | `tte_5h_sec < 7200`                                       |

## Frontmatter schema

```yaml
---
name: <unique-slug>                 # must match the filename stem
kind: reminder | fsm | adversarial  # routing hint, picks body register
trigger:                            # ALL predicates must fire (AND)
  <metric>_above: <n>               # strict >
  <metric>_below: <n>               # strict <
  <metric>_min: <n>                 # >=
  <metric>_max: <n>                 # <=
priority: 10..99                    # higher wins when multiple fire
cooldown_min: 5..120                # quiet period after each fire
---
Body text. ≤ 60 tokens.
Supports {placeholder} substitution from the metrics dict so the
fired body can reference the current metric values inline.
```

Supported placeholder sources at fire time include every metric
name the evaluator sees (`context`, `ratio`, `edits`, `reads`,
`mcp_loaded_count`, `mcp_used_count`, `agent_spawns`, `lr_risk`,
`tte_5h_sec`). Unknown placeholders pass through untouched so you
see them in-line — a clear "this needs to be wired up" signal.

## Adding a new hook

1. Drop a Markdown file into `config/hooks/`.
2. Give it a unique `name` and `kind`.
3. Name your trigger conditions using one of the four suffixes
   (`_above` / `_below` / `_min` / `_max`). The stem must be a key
   the evaluator produces (grep `src/hooks/emit.js:metrics = {…}`).
4. No code change required. The evaluator reloads the directory on
   every Claude Code prompt submission.

Tests in `src/hooks/evaluator.test.js` cover frontmatter parsing,
trigger evaluation, priority sorting, and cooldown handling.

## Audit

Every fired hook appends to
`~/.claude/plugins/claude-ops/hook-log.jsonl`:

```
{"ts":1777000000000,"name":"read-before-edit","kind":"reminder","metrics":{…}}
```

Cooldown state lives in `hook-state.jsonl` in the same dir —
append-only, latest entry per hook name wins. Both files are safe
to delete if state corrupts; the evaluator falls back to the
per-hook `cooldown_min` default on first fire.

## Design constraints

- **No more than one hook per prompt submission.** Multiple hooks
  would compete for the short additional-context surface; we pick the
  highest priority and save the rest for next time.
- **Cooldowns are per-hook, not global.** Distinct reminders don't
  block each other.
- **Hooks are advisory by default.** Claude Ops can emit a blocking hook result
  only when `CLAUDE_OPS_HOOK_MODE=blocking` is explicitly set for experiments.
- **Bodies are the product.** The frontmatter and evaluator are
  scaffolding; the user-facing signal is the body text itself. Edit
  freely — tests pin parsing and trigger math, not body copy.
