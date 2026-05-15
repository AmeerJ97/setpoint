---
name: mcp-bloat
kind: reminder
trigger:
  mcp_loaded_min: 5
  mcp_used_max: 2
priority: 40
cooldown_min: 120
---
You have {mcp_loaded_count} MCP servers loaded but only {mcp_used_count} have been used this session. Every idle MCP costs tool-schema tokens on every request. Consider:
- Unloading MCPs not needed for today's work (`claude mcp remove`).
- Keeping only what the current project actually touches.
- Per-project `.mcp.json` instead of global `mcpServers` for project-specific tools.
