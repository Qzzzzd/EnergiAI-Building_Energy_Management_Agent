---
name: building-energy-skill1-parse
description: Invoke the V0.7 building-energy Skill 1 boundary and local two-header XLSX reference parser. Use when an agent must validate a ParseRequest, run or inspect a local parse job, validate a DatasetBundle, or consume a DatasetBundle ID without cleaning, merging, or feature engineering.
---

# Skill 1: Data parsing

## Responsibility

Accept stable references to one or more supported files, identify time-series
and regular tables, and produce a traceable DatasetBundle. Parse each file and
worksheet independently. Preserve raw values and source lineage.

The current service synchronously parses the approved two-header XLSX reference
shape behind the existing `start`, `status`, and `result` methods. Other source
shapes remain unsupported or require input.

## Preconditions and trigger

Use this Skill when a caller supplies at least one stable `source_ref` and needs
the V0.7 parsing boundary. Require reproducible snapshots for temporary uploads.
Do not guess when key fields are ambiguous; preserve the `needs_input` semantic
so the calling agent can ask the user.

## Input

Use `building_energy_agent.contracts.skill1_v07.ParseRequest`:

- `sources`: one or more `SourceReference` objects;
- `parse_hints`: optional extensible object, empty by default; set
  `source_timezone` when source timestamps are naive;
- `strict_mode`: optional boolean, `false` by default.

## Output

Return only lightweight asynchronous response models:

```text
start(ParseRequest) -> job_id, status
status(job_id) -> status, progress, current_stage, warnings
result(job_id) -> dataset_bundle_id, summary
```

Store observations in the DatasetBundle, never in the response. The minimum
time-series logical schema is `timestamp`, `point_id`, and numeric-or-null
`value_raw`; timestamps are timezone-aware UTC.
Record deterministic text-to-number mappings for state and enum points in
`parse_report.json.state_encodings`; completed-bundle validation must reject
unknown point references or non-finite encoding values.

## Prohibitions

- Do not merge different files or worksheets automatically.
- Do not clean, interpolate, repair outliers, resample, engineer features, or
  split training data.
- Do not execute macros.
- Do not accept an arbitrary local path in `ParseRequest`; register it as a
  stable `source_ref` first.

## Contract reference

Follow `docs/contracts/skill1-skill2-io-v0.7.md` for input and service
semantics. Follow `docs/contracts/skill1-skill2-output-v0.7-skill34.md` for
output; it takes priority when the documents conflict about output.
