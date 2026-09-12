#!/usr/bin/env python3
"""Run inside the existing managed sandbox to configure the native drafting workers."""
import json
import os
from pathlib import Path

root = Path(os.environ.get("OPENCLAW_HOME", "/sandbox")) / ".openclaw"
path = root / "openclaw.json"
config = json.loads(path.read_text())
agents = config["agents"]["list"]
assert {"main", "product", "support"}.issubset({a["id"] for a in agents})
for agent in agents:
    if agent["id"] == "main":
        agent.setdefault("subagents", {}).update(allowAgents=["product", "support"], requireAgentId=True)
    elif agent["id"] in ("product", "support"):
        tools = agent.setdefault("tools", {})
        tools["allow"] = ["read", "session_status"]
        tools["deny"] = list(dict.fromkeys(tools.get("deny", []) + ["exec", "process", "write", "edit", "apply_patch", "sessions_spawn"]))

instructions = root / "workspace" / "AGENTS.md"
marker = "# Scoped task handoff"
text = instructions.read_text()
if marker not in text:
    instructions.write_text(text + "\n\n" + marker + "\n"
        "Give every child the EXACT current user objective, complete directly relevant supplied evidence, "
        "constraints, requested response length, citations, and acceptance criteria. Do not substitute "
        "a retrieved project or topic for the current objective. Product and support workers are read-only; "
        "ask them to answer from the packet when it is sufficient. Never request unnecessary shell commands. "
        "Wait for both required native child completion announcements before returning a joined answer.\n")
path.write_text(json.dumps(config, indent=2) + "\n")
path.chmod(0o600)
print("Configured explicit product/support delegation and read-only drafting workers; coordinator exec policy unchanged.")
