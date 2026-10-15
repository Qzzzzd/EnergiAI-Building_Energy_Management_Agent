# ProcessingBundle contract for Skill 4

Skill 4 resolves bundles below `<artifact-root>/processing-bundles/<processing_bundle_id>/`.

Required files:

```text
manifest.json
feature_catalog.parquet
target_metadata.json
split_manifest.json
categorical_mappings.json
features/split=<split>/data.parquet
forecast_index/split=<split>/data.parquet
labels/split=<split>/data.parquet       # backtest only
```

Backtest bundles require `train`, `validation`, and `test`. Future bundles require `future`.

`manifest.json` must contain:

```json
{
  "bundle_type": "ProcessingBundle",
  "bundle_version": "0.7",
  "processing_bundle_id": "...",
  "leakage_check_status": "passed",
  "leakage_check_rule_version": "...",
  "processing_rule_version": "...",
  "data_granularity": "...",
  "feature_schema_fingerprint": "...",
  "file_hashes": {"relative/path": "sha256"}
}
```

Feature rows have one unique `sample_id`, cutoff/start/end timestamps, and the feature columns
listed in the catalog. Forecast-index rows have unique `(sample_id, target_timestamp)`,
monotonic integer `horizon_step`, `horizon_duration`, and future-known calendar features.
Labels use `(sample_id, target_timestamp, target_value)`.

The feature catalog requires `feature_name`, `data_type`, `source_point_id`, and
`semantic_version`. Supported types are `numeric`, `boolean`, and `categorical`.
Skill 2 owns categorical integer encodings and must reserve an unknown value.
Feature catalog names must not overlap forecast-index keys or future-known
feature columns. When reusing a model, the future bundle must match the
training bundle's target metadata, feature schema, categorical mappings, data
granularity, processing rule version, and leakage-check rule version.
