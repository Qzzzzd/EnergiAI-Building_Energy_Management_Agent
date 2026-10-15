# 数据契约

## DatasetBundle

从 `<artifact-root>/dataset-bundles/<source_bundle_id>/` 解析输入：

```text
manifest.json
points.parquet
parse_report.json
data/timeseries/**/*.parquet
```

`manifest.json` 必须包含 `bundle_type = "DatasetBundle"`、`bundle_version`、
`dataset_bundle_id`、`schema_fingerprint` 以及 `time_start`/`time_end`。时序文件必须包含
`timestamp`、`point_id` 和 `value_raw`。`points.parquet` 必须包含 `point_id`、`name`、
`description`、`unit`、`variable_type` 和 `expected_interval_seconds`。

`variable_type` 支持 `continuous`、`state` 和 `enum`。
候选 Profile 使用点位目录中的 `expected_interval_seconds`。如果 Skill 1 在
`parse_report.json.state_encodings` 中记录了 state/enum 文本编码，将对应数值加入该点位
质量规则的允许值。

## QualityAssessmentSpec

```json
{
  "source_bundle_id": "bundle-id",
  "assessment_context": {
    "task_type": "load_forecasting",
    "target_point_id": "target-id"
  },
  "quality_profile_id": null
}
```

Profile ID 是不可变的内容哈希。输出保存在
`quality-assessment-bundles/<assessment_id>/` 下。

稳定任务状态包括 `queued`、`running`、`needs_input`、`succeeded` 和 `failed`。
错误结构使用 `{code, message, details}`。
