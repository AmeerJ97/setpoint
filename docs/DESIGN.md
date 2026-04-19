# Design Decisions

## Why a separate project vs patching the old HUD

The original HUD was a quick proof-of-concept. It works but has
fundamental issues:

1. Written as compiled TypeScript — every change requires rebuild
2. No analytics engine — just displays what stdin gives it
3. Lines appear/disappear based on data availability (bad UX)
4. No guard integration
5. No advisory system
6. Horizontal layout breaks on narrow terminals

claude-hud is a proper production tool that replaces it entirely.

## Why Node.js ESM, not TypeScript

The HUD runs as a Claude Code status line plugin. It needs to be:
- Fast to start (no compile step)
- Easy to patch live (edit JS, restart session)
- Compatible with Claude Code's Node runtime
- Zero npm dependencies if possible (ship as single files)

TypeScript adds a build step that slows iteration. Use JSDoc type
annotations for IDE support without compilation.

## Why JSONL over SQLite for history

SQLite requires better-sqlite3 (native addon, needs node-gyp).
JSONL is:
- Append-only (safe against corruption)
- Human-readable (can tail/grep)
- No native dependencies
- Good enough for rolling 7-day windows

If we ever need complex queries, migrate to SQLite later.

## Why not auto-adjust effort/model

The advisor RECOMMENDS but never auto-applies changes because:
1. User might have a reason for current settings
2. Mid-session model changes could disrupt context
3. Effort level changes affect response quality — user should decide
4. Transparency > automation for something this impactful

## Guard architecture

The quality guard runs as a separate systemd service (inotifywait-based).
The HUD reads the guard's log file to display status. They don't share
process space. This means:
- Guard survives HUD restarts
- HUD survives guard restarts
- Both can be independently monitored
- No IPC complexity

## Regarding session compression / summarize_tool_results

The `tengu_summarize_tool_results: true` flag causes Claude Code to 
compress tool outputs before showing them. This is one of the most
impactful quality flags. The guard keeps it `false`.

If the user notices compressed output despite the guard, it means:
1. Guard hasn't caught the revert yet (check guard line)
2. The flag was applied during session init before guard activated
3. Solution: restart the session after confirming guard is running

The HUD should show a "compression" indicator if the cached value
of tengu_summarize_tool_results is true — so the user knows to restart.
