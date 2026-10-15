---
name: building-energy-data-parsing
description: Parse immutable building-energy XLSX, XLSM, deterministic long-form CSV, or deterministic wide-form CSV snapshots into a validated DatasetBundle without cleaning or changing observations. Use when Codex must ingest an uploaded building-energy source, ask for an ambiguous source timezone, validate source hashes, or produce the required input bundle for processing or data-quality assessment.
---

# Parse building-energy data

During a Codex turn, run the repository foreground lifecycle driver from the
session workspace. It keeps the worker inside the workspace-write sandbox,
streams every lifecycle event, waits for a terminal state, and returns the
result:

```bash
skill-run start --skill building-energy-data-parsing \
  --request request.json --session-id <session_id> --turn-id <turn_id> \
  --workspace-root .
```

Resume a `needs_input` job with `skill-run resume --skill
building-energy-data-parsing --job-id ID --answers answers.json
--workspace-root .`. The underlying project-managed `skillctl` remains the
operator interface for direct `start`, `status`, `result`, `resume`, and
`cancel` operations. Every command emits `BE_SKILL_EVENT ` JSONL. Keep the
returned job ID stable when resuming.

## Request

Pass only immutable session-relative source snapshots:

```json
{
  "sources": [
    {
      "relative_path": "../inputs/<batch>/<snapshot>.xlsx",
      "source_ref": "src:<opaque-id>",
      "sha256": "<sha256>"
    }
  ],
  "parse_hints": {"source_timezone": "Asia/Shanghai"},
  "strict_mode": false
}
```

Use XLSX/XLSM only for the approved two-header workbook layout. Treat XLSM as
read-only data: do not execute, extract, or preserve VBA. Read formulas only from
cached values and report missing caches. Accept CSV only as UTF-8 or UTF-8 BOM
with comma delimiters:

- Long form requires exactly `timestamp`, `point_id`, `value_raw`, plus declared metadata columns.
- Wide form requires exactly one recognized time column; every other column name is a stable point ID.

Do not guess an ambiguous layout or timezone. Resume with structured answers,
for example `{"source_timezone":"Asia/Shanghai"}`.

## Output and boundaries

Keep the validated native `DatasetBundle` under the controlled artifact root,
but publish only its contract-safe public `ArtifactManifest`, ID, small summary,
report, real PNGs, and warnings. Preserve nulls, gaps, source lineage, raw values, point IDs, state
encodings, source timezone, and UTC conversion. Do not merge workbook sheets,
clean, interpolate, resample, repair outliers, engineer features, train models,
or expose absolute paths and bulk observations.

Never create an environment or install dependencies during a business turn. If
the managed environment is missing, return `DEPENDENCY_MISSING` and direct the
operator to `scripts/install-skills building-energy-data-parsing`.
