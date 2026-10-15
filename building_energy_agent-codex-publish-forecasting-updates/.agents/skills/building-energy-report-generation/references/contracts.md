# Report Skill contract reference

## Required sources

| Report type | Required public Artifact IDs | Optional IDs |
| --- | --- | --- |
| `quality` | `quality` | `processing` |
| `forecast-evaluation` | `evaluation` | `processing`, `quality` |
| `forecast-future` | `forecast` | `processing`, `quality` |
| `integrated` | `quality` and at least one of `evaluation`/`forecast` | `processing` |

The caller supplies the IDs explicitly. The Skill never scans the session for a
recent or “best” source.

## Narrative block contract

The Codex planning layer should pass one narrative block for every fixed
chapter whose source is verifiable. The low-level lifecycle remains backward
compatible with an omitted list and generates a deterministic fallback in that
case.

```json
{
  "section_id": "quality-diagnosis",
  "takeaway": "一句章节核心结论",
  "body": "两至四段结果解释、业务含义和适用边界",
  "next_action": "可选行动建议",
  "caveats": ["可选限制"],
  "evidence_refs": ["artifact-..."],
  "fact_refs": ["fact:quality"],
  "chart_refs": ["quality_score_overview"],
  "visual_notes": [
    {"kind": "chart", "ref": "quality_score_overview", "text": "如何阅读图表及其限制"},
    {"kind": "table", "ref": "六维质量结果", "text": "如何阅读表格及其限制"}
  ]
}
```

`evidence_refs` must cover the source required by the chapter. `fact_refs`
must point to the corresponding public fact namespace. `chart_refs` may contain
only chart IDs selected by the fixed registry for this report. `visual_notes`
uses exact selected chart IDs or registered table captions; each note explains
how to read the visual and what it cannot prove. Numeric tokens in the text
must be present in the cited facts or an accepted display form of those facts.
Unsupported blocks or visual notes are rejected chapter-by-chapter and replaced
by deterministic wording.

## Public source shapes

The source directory is `artifacts/public-artifacts/<artifact_id>/`. The public
manifest contains the standard `ArtifactManifest` fields and may expose these
roles:

- `summary`: compact JSON summary
- `native-manifest`: provenance metadata only; never follow its internal file paths
- `metrics`, `forecast-preview`, or `report`: public supporting evidence
- `visualization`: verified PNG files

The report may read the native-manifest file as a public provenance record for
bundle IDs, target/model/processing linkage, version fingerprints, and time
range. It must not use the native manifest to reopen Parquet, model binaries, or
other private files.

## Compatibility checks

Use the following public fields when present:

- Dataset identity: `native.source_bundle_id`, `native.dataset_bundle_id`, or
  `summary.source_bundle_id`.
- Target identity: `summary.target_point_id` or
  `summary.source_target_point_id`.
- Processing identity: `native.processing_bundle_id`.
- Model identity: `native.model_bundle_id`.
- Mode: `summary.mode` or `native.processing_mode`.
- Feature/leakage chain: `native.feature_schema_fingerprint`,
  `native.leakage_check_rule_version`, and `native.leakage_check_status`.

Quality sources normally expose DatasetBundle identity. Evaluation and future
forecast sources expose ProcessingBundle and ModelBundle identity; a processing
Artifact is needed to prove their DatasetBundle identity. If that public link is
not supplied, do not guess it from upload source IDs: state that the integrated
chain is unproven and mark the report partial.

`forecast-evaluation` requires backtest/evaluation semantics. `forecast-future`
requires future semantics. A future prediction is never historical accuracy.

## Result states

- Missing required ID: return `needs_input` with independent questions.
- Invalid request, wrong Artifact type, missing manifest, unsafe path, or hash
  mismatch: return `failed`.
- Verifiable source with partial warnings or missing selected figures: publish
  an HTML report with `partial` status.
- No verifiable required source: do not publish a formal report.

The report Artifact is `building-energy.report`, has two listed report files
`report.html` and `report.pdf`, and uses the normal `ArtifactRef` lifecycle.
HTML is the controlled in-app preview; PDF is the printable/downloadable copy.
Both files are generated from the same sections, accepted/fallback narrative
blocks, and verified charts. `summary.narrative` records the policy version,
visual-note policy version, mode (`codex`, `mixed`, or
`deterministic-fallback`), covered sections, fallback sections, block count,
visual-note count, and character count. Report cache identity is derived from
source manifest hashes, report type/title/config, effective narrative blocks,
narrative policy version, visual-note policy version, template version, renderer
version, and chart registry version.
