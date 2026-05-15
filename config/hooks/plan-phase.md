---
name: plan-phase
kind: fsm
trigger:
  edits_session_min: 5
  task_updates_session_max: 0
priority: 60
cooldown_min: 30
---
You have made 5+ Edits this session without a single TaskUpdate. The FSM phase you should be in is Plan:
- Break the work into at least 2 discrete tasks via TaskCreate.
- Mark one as in_progress so the next edit has a named anchor.
- If the work genuinely is 10+ Edits to one file, that's a refactor — declare it, don't drift into it.

Untracked edits are how you end a session with 200 lines of code and no commit.
