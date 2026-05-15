---
name: backlog-drift
kind: reminder
trigger:
  agent_spawns_session_min: 3
priority: 30
cooldown_min: 60
---
You have spawned {agent_spawns} sub-agents this session. Which of their outputs is still load-bearing, and which are just residue?
- If an agent report has not been referenced in the last 10 turns, it is not in context anymore — cite it explicitly or drop the thread.
- Parallel sub-agents are for independent research, not sequential decomposition.
- If the same sub-task keeps being re-spawned, it is a planning failure, not a subagent failure.
