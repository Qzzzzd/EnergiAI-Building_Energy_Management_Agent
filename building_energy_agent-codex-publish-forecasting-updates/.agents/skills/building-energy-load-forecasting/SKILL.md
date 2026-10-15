---
name: building-energy-load-forecasting
description: Train, evaluate, persist, and reuse V0.7 building-load forecasting models from a validated leakage-safe ProcessingBundle, producing ModelBundle, EvaluationBundle, or future ForecastBundle artifacts. Use when Codex must run historical evaluation or future load prediction, validate feature mappings and forecast indexes, or report honest dependency and visualization degradation.
---

# Forecast building-energy load

During a Codex turn, use the repository foreground lifecycle driver. It keeps
the worker inside the workspace-write sandbox and polls through the terminal
result:

```bash
skill-run start --skill building-energy-load-forecasting \
  --request request.json --session-id <session_id> --turn-id <turn_id> \
  --workspace-root .
```

Resume with `skill-run resume --skill
building-energy-load-forecasting --job-id ID --answers answers.json
--workspace-root .`. The underlying project-managed `skillctl` remains the
operator interface for direct `start`, `status`, `result`, `resume`, and
`cancel`. Forecast jobs do not normally enter `needs_input`, but the common
resume operation rejects invalid state transitions. Every command emits
`BE_SKILL_EVENT ` JSONL and persists job state.

Consume only a compatible Skill 2 `ProcessingBundle`. For historical
evaluation, provide `processing_bundle_id` and optional
`forecast_spec.mode="backtest"`. For future prediction, provide
`model_bundle_id`, a future-mode `processing_bundle_id`, and explicit
`forecast_start`/`forecast_end`.

Validate bundle versions, file hashes, leakage-rule versions, feature schema,
categorical mappings, target metadata, data grid, partitions, and forecast
index. Never read raw Excel/CSV or build features here. Treat artifact metrics
as authoritative; report test CVRMSE, coverage, warnings, and negative raw
prediction statistics without rewriting values.

Keep native ModelBundle/EvaluationBundle/ForecastBundle contents internal and
publish registered public `ArtifactManifest` references with small summaries,
reports, real PNGs, and at most 200 forecast-preview rows. Never expose model
binaries or Parquet. If display dependencies or figures are missing, return
`partial`; never fabricate a PNG. If LightGBM or another declared runtime
dependency is unavailable, return `DEPENDENCY_MISSING` and direct the operator
to `scripts/install-skills building-energy-load-forecasting`. Never install a
dependency during a business turn. Read
`references/processing-bundle-contract.md` for compatibility failures.
