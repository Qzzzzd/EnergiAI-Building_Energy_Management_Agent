---
name: building-energy-data-quality
description: Perform a read-only, resumable six-dimension quality assessment of a validated building-energy DatasetBundle and publish a traceable Chinese QualityAssessmentBundle. Use when Codex must assess completeness, accuracy, comprehensiveness, range, consistency, or information entropy, or confirm a generated QualityProfile without blocking an independent forecast branch.
---

# Assess building-energy data quality

During a Codex turn, use the repository foreground lifecycle driver. It keeps
the worker inside the workspace-write sandbox and polls through the terminal
result:

```bash
skill-run start --skill building-energy-data-quality \
  --request request.json --session-id <session_id> --turn-id <turn_id> \
  --workspace-root .
```

Resume with `skill-run resume --skill
building-energy-data-quality --job-id ID --answers answers.json
--workspace-root .`. The underlying project-managed `skillctl` remains the
operator interface for direct `start`, `status`, `result`, `resume`, and
`cancel` with the same stable job ID. Every command emits `BE_SKILL_EVENT `
JSONL and persists state.

Consume only a validated Skill 1 `DatasetBundle`; do not read raw Excel/CSV or
modify observations. Provide `source_bundle_id`, `assessment_context.task_type`,
and the target point when the task requires one.

When the job returns `needs_input`, present all currently independent
`required_inputs` and the candidate profile. Resume the same job using an
answers object containing `quality_profile` or `profile`. Prefer point-specific
`expected_interval_seconds` and preserve Skill 1 `state_encodings`. Do not
overwrite dataset metadata with defaults.

Report non-computable dimensions explicitly and do not calculate an overall
score if any dimension is non-computable. Severity is advisory and must not
block the separate forecast branch. Keep the native QualityAssessmentBundle
internal and publish only a contract-safe public `ArtifactManifest` containing
its small authoritative summary, report, real PNGs, and warnings. Read `references/contracts.md`
for compatibility and `references/formulas.md` when explaining scores.

Never install dependencies during a business turn. Return `DEPENDENCY_MISSING`
and direct the operator to `scripts/install-skills building-energy-data-quality`.
