---
name: adversarial-why
kind: adversarial
trigger:
  lr_risk_above: 0.6
priority: 50
cooldown_min: 30
---
The advisor classifier says this session is drifting (risk={lr_risk}). Before the next action, demonstrate understanding:
- Name 3 concrete edge cases your current approach does not handle.
- State the invariant any new code must preserve.
- If you cannot answer either in one sentence each, STOP and re-read the problem statement.

"Looks right" is not a passing grade. Explicit falsifiability is.
