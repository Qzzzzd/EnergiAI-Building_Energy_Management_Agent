---
name: building-energy-dynamic-proof
description: Produce a deterministic, contract-valid proof Artifact for the Building Energy Codex extensibility acceptance. Use only when the user explicitly asks to verify dynamic Skill discovery and execution; do not use for building-energy analysis.
---

# Dynamic Skill proof

This acceptance-only Skill has no Python environment and installs no dependency.
Run its repository script from the current session workspace:

```bash
<repo>/.agents/skills/building-energy-dynamic-proof/scripts/run \
  --session-id <session_id> --turn-id <turn_id> --workspace-root .
```

The script emits strict `BE_SKILL_EVENT` JSONL and creates one small, real JSON
Artifact under the current session's `artifacts/` directory. Return the emitted
Artifact reference exactly. Never run this Skill unless the request explicitly
asks for the dynamic architecture proof.
