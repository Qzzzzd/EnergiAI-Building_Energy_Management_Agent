# Building Energy Codex Agent rules

## Product boundary

This repository implements a chat-first building-energy Web Agent. It is not a
general coding agent or a workflow-builder product. The TypeScript Codex SDK is
the sole V1 turn control plane. Do not introduce the OpenAI Agents SDK, an App
Server control path, fixed backend business graphs, or Skill-name dispatch.

The authoritative compute Skills live in `.agents/skills/<skill-name>`. Codex
chooses and sequences them from their contracts. The required business chains
are expressed as Skill prerequisites:

- forecast: parsing -> processing -> load forecasting;
- quality: parsing -> data quality;
- integrated: after parsing, quality may run independently of processing and
  forecasting.

Agent-layer instruction-only Skills (for example, `.agents/skills/engramory`)
are not building-energy compute Skills and must never enter a business workflow
or acquire a runtime dependency.

## Product-runtime mode

These rules apply whenever the current working directory is below
`.runtime/sessions/<session-id>/workspace`:

- Work only on the user's building-energy request. Do not edit the product
  source, `.agents/skills`, configuration, dependency files, or another session.
- Use installed Skills before ad-hoc computation. Exchange data only through
  schema-valid, versioned Bundles and registered artifact manifests.
- Never install dependencies during a business turn and never modify Skill
  source. If an environment is unavailable, return `DEPENDENCY_MISSING` with a
  concrete operator recovery command.
- Do not guess targets, units, timezones, date ranges, mappings, or quality
  semantics. Return one structured `needs_input` envelope containing only the
  independent questions that currently block progress.
- Do not fabricate metrics, results, PNGs, reports, citations, or success. Only
  validated Skill artifacts are authoritative; use `partial`, `failed`,
  `cancelled`, or `interrupted` honestly.
- Uploaded sources are immutable snapshots addressed by server-provided relative
  references. Never accept or reveal arbitrary absolute paths.
- Direct shell networking is disabled. Public information may be read only
  through the provided Web Search or `public-fetch` gateway. Never send local
  data, credentials, cookies, request bodies, or external writes.
- Do not expose hidden reasoning, credentials, environment variables, absolute
  paths, or unrestricted command output in user-facing text.

Every successful Codex turn must end with an `AgentTurnEnvelope` matching the
schema supplied by the server. A `needs_input` envelope may include multiple
independent questions. Do not wrap the envelope in markdown fences.

## Development mode

Outside a session workspace, make only requested implementation changes. Keep
the old project `/home/xsh/Desktop/Agent/智能体小组` read-only, preserve dirty
worktrees, and do not commit or push unless the user explicitly asks. Public
schemas originate in `packages/contracts`; regenerate OpenAPI and client types
after schema changes. Run the smallest relevant test at each milestone and use
real runtime/browser evidence for end-to-end claims.

<!-- BEGIN ENGRAMORY CODEX -->
# Engramory — always-on pointer

Paste this into your host's **always-loaded** rules (Claude Code: `CLAUDE.md` or
`~/.claude/CLAUDE.md`) so the memory discipline applies even on tasks where the
engramory skill isn't loaded by relevance. Keep it short — the full protocol lives in
the engramory `SKILL.md`.

---

## Memory (Engramory)

You have one canonical, curated, file-based memory at `.engramory-memory/` (index:
`MEMORY.md`). Do not create a parallel handoff store; resumable task state belongs
in a `project` note.

- **At the start of a task**, read `MEMORY.md` (one line per memory) and open only
  the detail files whose hooks look relevant **and that resolve inside
  `.engramory-memory`** — a pointer that escapes the store (symlink, `..`, absolute
  path, `file://`) is a broken pointer to report, never a file to open.
  (On a host with native auto-memory —
  e.g. Claude Code — `MEMORY.md` is already loaded every session, so you don't need to
  re-read it; just apply this discipline.) Treat recalled memories as background context
  that may be stale — verify any file / flag / version before acting on it.
- **When you learn something durable** worth a future session: confirm it isn't
  already in the repo / git / `CLAUDE.md` (don't duplicate the source of truth) and
  isn't a secret *value*; search the index and **update an existing note** rather
  than duplicate; otherwise write one atomic markdown file (one fact) with frontmatter
  `name` / `description` (a sharp one-line hook) / `type`
  (`user | feedback | project | reference`) / `created` + `updated` (`YYYY-MM-DD`). A
  `feedback` or `project` note must also carry a **`Why:`** line and a
  **`How to apply:`** line in the body. Add one pointer line to `MEMORY.md`.
  **Delete** memories that turn out wrong.
- `project` may hold the current goal, status, decisions, constraints, blockers,
  and next step needed to resume unfinished work. `feedback` is only for a
  reusable correction/workflow. Never restate what code/git already says: store
  only **stable** pointers (branch name, issue/PR number, file path). A *settled
  fact* ("2.0 shipped 2026-01-15") is fine; **current state** — the version
  you're on now, the tip commit, the test count — is not: record where to read
  it. Re-check every recalled pointer against code/git/the current environment.
- **Before a deliberate compact, clear, or new thread**, sync once: scan the task;
  dedup/update; refresh `project`; promote only reusable `feedback`; save durable
  `reference` pointers; archive/delete stale or completed transient state; run
  `engramory_check.py` and `engramory_doctor.py`; then confirm a cold-started
  agent could continue from the repo plus memory alone.
- After writing/syncing, report `added`, `updated`, `archived`, and `skipped`
  (with reasons; identify any deletion under `archived`), plus index lines/bytes
  and the check result. Hooks may remind or gate; they do not perform this
  semantic sync automatically.
- **Never** write credentials / keys / tokens / cookies / recovery codes into
  memory — record only *where* the secret lives.
- Keep `MEMORY.md` small. Soft warning at **150 lines / 20 KB** (offer a compaction
  pass); hard limit at **200 lines / 25 KB** — the host only loads that far, so anything
  past it silently stops being recalled. Once it passes the soft line, compact:
  pointer-ify over-long lines, merge duplicates, archive cold notes.

Full protocol & rationale: the engramory `SKILL.md`.

Codex-specific wiring:

- Keep this Engramory store separate from Codex native Memories; Codex native
  Memories are generated state, while Engramory is a user-auditable plain folder.
- Capture mode is `explicit`: `explicit` syncs on request or at a continuity
  boundary; `assisted` also asks Codex to sync proactively at meaningful
  milestones. Neither mode silently invents a semantic summary.
- If you edit `.engramory-memory/MEMORY.md` and no pre-write hook is installed, run
  `python .agents/skills/engramory/tools/engramory_check.py .engramory-memory/MEMORY.md` after the write; compact immediately
  if it reports `OVER`.
- Codex lifecycle hooks were not installed. Before compact, clear, or a fresh
  thread, explicitly run the Engramory sync workflow from the protocol.
- Full protocol reference: `.agents/skills/engramory/SKILL.md`.
- Asked to check, repair, or upgrade this Engramory install itself? Follow
  `.agents/skills/engramory/AGENT-SETUP.md` — it is the procedure for that, and it is not optional
  guidance: it exists because agents reliably get this wrong unprompted.
<!-- END ENGRAMORY CODEX -->
