---
name: investigate-phase
kind: fsm
trigger:
  reads_this_turn_max: 0
  edits_this_turn_min: 1
priority: 70
cooldown_min: 10
---
You edited without Reading, Grep'ing, or Glob'ing this turn — you are jumping from Prompt straight to Execute, skipping Investigate. The FSM phase you SHOULD be in right now is Investigate:
- Read the target file.
- Grep for callers and tests.
- Only then propose the edit.

If you have already established context in a prior turn, say so explicitly ("continuing from prior Read at file:line") — otherwise treat the current change as uninformed.
