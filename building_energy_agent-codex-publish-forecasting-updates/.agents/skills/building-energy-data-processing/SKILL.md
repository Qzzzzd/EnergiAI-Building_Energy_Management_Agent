---
name: building-energy-data-processing
description: Convert a validated building-energy DatasetBundle into a leakage-safe V0.7 ProcessingBundle using the approved 24-hour building-energy-history-v2 feature pipeline. Use when Codex must prepare a selected load target for forecasting, preserve real gaps, validate target and horizon semantics, or produce the only supported input for load forecasting.
---

# Process forecasting data

During a Codex turn, use the repository foreground lifecycle driver. It keeps
the worker inside the workspace-write sandbox and polls through the terminal
result:

```bash
skill-run start --skill building-energy-data-processing \
  --request request.json --session-id <session_id> --turn-id <turn_id> \
  --workspace-root .
```

Resume with `skill-run resume --skill
building-energy-data-processing --job-id ID --answers answers.json
--workspace-root .`. The underlying project-managed `skillctl` remains the
operator interface for direct `start`, `status`, `result`, `resume`, and
`cancel`. Every command emits `BE_SKILL_EVENT ` JSONL and persists job state in
the session workspace.

## Preconditions and request

Consume only a schema- and hash-valid `DatasetBundle` in the shared session
artifact root. Do not accept Excel, CSV, a DataFrame, natural-language data, or
an arbitrary path.

```json
{
  "source_bundle_id": "dataset-...",
  "target": {"point_id": "..."},
  "prediction_spec": {"forecast_horizon": "24h"},
  "feature_spec": {"preset": "default"},
  "data_scope": {"local_timezone": "Asia/Shanghai"},
  "split_spec": {"anchor_time": "00:00"}
}
```

Use a 24-hour horizon and `Asia/Shanghai` only when the user did not override
them. Ask for input when the target is absent or ambiguous. Reject non-positive
or target-grid-incompatible horizons.

## Deterministic rules and output

Treat `default` as `building-energy-history-v2`. Require complete preceding
target history, keep real gaps, build native-grid lag/rolling/delta/previous-day
features, enforce temporal splits, and pass the declared leakage rule. Never
interpolate target gaps or use future information.

Keep the validated native `ProcessingBundle` internal and publish only its
contract-safe public `ArtifactManifest`, ID, small summary/report, real PNGs,
and warnings. Do not train, predict, evaluate, or mutate the source
bundle. Never install dependencies during a business turn; return
`DEPENDENCY_MISSING` with `scripts/install-skills building-energy-data-processing`
as the operator recovery command.
