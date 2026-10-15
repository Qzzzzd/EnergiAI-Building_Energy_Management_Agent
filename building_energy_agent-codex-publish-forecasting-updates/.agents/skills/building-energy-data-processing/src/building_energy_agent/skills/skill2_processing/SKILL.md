---
name: building-energy-skill2-processing
description: Build or inspect V0.7 building-energy ProcessingBundles from a Skill 1 DatasetBundle using one selected load point and the approved target-history-v1 backtest preset. Use when an agent must validate a ProcessingSpec, run or inspect the local Skill 2 job boundary, generate leakage-free one-minute features and labels for a 1-24 hour horizon, or pass a ProcessingBundle ID to the forecasting Skill.
---

# Skill 2: Forecast data processing

## Responsibility

Accept a Skill 1 `DatasetBundle` by `source_bundle_id`, select one target
`point_id`, and expose the boundary for processing, feature construction, label
construction, and leakage-free temporal splitting. Produce a ProcessingBundle
for downstream quality and forecasting Skills.

Use the synchronous local service implementation while preserving the public
`start`, `status`, and `result` job-shaped interface.

## Preconditions

Use this Skill only after Skill 1 produces a usable DatasetBundle. Require a
structured `ProcessingSpec`, including `target`, `prediction_spec`, and
`feature_spec`. Do not accept CSV, Excel, source paths, or natural-language
instructions directly. Preserve the `needs_input` semantic when required
information is ambiguous.

## Input

Use `building_energy_agent.contracts.skill2_v07.ProcessingSpec`:

- `source_bundle_id`: required opaque DatasetBundle ID;
- `target.point_id`: required single target ID;
- `prediction_spec`: required object; explicitly set a 1-24 hour horizon because
  the frozen `"7d"` default is outside the implemented V1 range;
- `feature_spec`: required object; preset defaults to `"default"`;
- `data_scope`, `split_spec`, `missing_values`, and `outliers`: optional,
  extensible objects.

## Output

Return only lightweight asynchronous response models:

```text
start(ProcessingSpec) -> job_id, status
status(job_id) -> status, progress, current_stage, warnings
result(job_id) -> processing_bundle_id, summary
```

Store processed time series, features, labels, catalogs, target metadata, and
split metadata in the ProcessingBundle. Associate FeatureSet and LabelSet
through stable `sample_id` values.

## Implemented preset

Treat `default` as `target-history-v1`. Require the preceding 1,440 complete
one-minute target values and generate the frozen five-feature order documented
in `docs/decisions/skill2-target-history-v1.md`. Use `Asia/Shanghai` and a
`00:00` daily anchor unless the request provides valid overrides.

Return `needs_input` when the target is absent or ambiguous, the horizon is
outside 1-24 hours, a split becomes empty, or no sample survives the history
check.

For frozen V0.7 output, require the selected target metadata to identify total
chiller load, use the `continuous` variable type, and use kW. Do not relabel an
arbitrary selected point as the fixed V0.7 Skill 4 target. Keep FeatureSet
names disjoint from forecast-index and metadata columns.

## Boundaries

- Do not read or accept raw CSV or Excel files.
- Do not provide general cleaning without a prediction target.
- Do not invent a feature preset or alter target-history-v1 in place.
- Do not interpolate target gaps.
- Do not train, predict, or evaluate models.
- Do not define detailed Skill 3/4 interfaces.
- Do not claim the future-request service or per-chiller Skill 4 metadata is
  implemented.

## Contract reference

Follow `docs/contracts/skill1-skill2-io-v0.7.md` for input and service
semantics. Follow `docs/contracts/skill1-skill2-output-v0.7-skill34.md` for
output; it takes priority when the documents conflict about output.
Follow `docs/decisions/skill2-resampling-v1.md` and
`docs/decisions/skill2-target-history-v1.md` for implemented V1 rules.
