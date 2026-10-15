"""Minimal target-history-v1 backtest pipeline for Skill 2."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from building_energy_agent.contracts.skill2_v07 import (
    FeatureCatalogEntry,
    FeatureSetRow,
    ForecastIndexRow,
    LabelSetRow,
    ProcessingSpec,
    TargetMetadata,
)
from building_energy_agent.core.artifact_store import dataset_bundle_root
from building_energy_agent.core.errors import SkillNeedsInputError
from building_energy_agent.skills.skill2_processing.bundle_writer import (
    LocalProcessingBundleWriter,
    ProcessingBundleWriteOutcome,
    ProcessingBundleWriteRequest,
)
from building_energy_agent.skills.skill2_processing.preflight import (
    DatasetBundleReader,
    TargetResolver,
    _validate_target_table,
    v07_target_compatibility_error,
)
from building_energy_agent.skills.skill2_processing.resampling import (
    GRID_STEP,
    TargetGridRow,
    build_target_grid,
    summarize_calendar_days,
)
from building_energy_agent.skills.skill2_processing.samples import (
    SamplePlanRow,
    build_horizon,
    build_sample_plan,
    parse_anchor_time,
    parse_forecast_horizon,
    split_valid_days,
)


FEATURE_RULE_VERSION = "target-history-v1"
HISTORY_MINUTES = 1_440
SUPPORTED_PRESETS = {"default", FEATURE_RULE_VERSION}
FEATURE_DEFINITIONS = (
    ("target_lag_1min", "numeric", "lag-1min-v1"),
    ("target_lag_60min", "numeric", "lag-60min-v1"),
    ("target_lag_1440min", "numeric", "lag-1440min-v1"),
    ("target_mean_60min", "numeric", "mean-previous-60min-v1"),
    ("target_mean_1440min", "numeric", "mean-previous-1440min-v1"),
)


@dataclass(frozen=True, slots=True)
class Skill2PipelineOutcome:
    bundle: ProcessingBundleWriteOutcome
    summary: dict[str, Any]
    warnings: tuple[str, ...]


class Skill2BacktestPipeline:
    """Build one backtest bundle from a resolved DatasetBundle target."""

    def __init__(self, artifact_root: str | Path) -> None:
        self.artifact_root = Path(artifact_root).expanduser().resolve()
        self.writer = LocalProcessingBundleWriter(self.artifact_root)

    def run(self, request: ProcessingSpec) -> Skill2PipelineOutcome:
        if request.feature_spec.preset not in SUPPORTED_PRESETS:
            raise SkillNeedsInputError(
                f"feature preset must be one of {sorted(SUPPORTED_PRESETS)!r}"
            )
        local_timezone = _string_setting(
            request.data_scope,
            "local_timezone",
            "Asia/Shanghai",
        )
        anchor_time_text = _string_setting(
            request.split_spec,
            "anchor_time",
            "00:00",
        )
        try:
            timezone = ZoneInfo(local_timezone)
            anchor_time = parse_anchor_time(anchor_time_text)
            horizon_minutes = parse_forecast_horizon(
                request.prediction_spec.forecast_horizon
            )
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise SkillNeedsInputError(str(exc)) from exc

        reader = DatasetBundleReader(
            dataset_bundle_root(self.artifact_root, request.source_bundle_id)
        )
        resolution = TargetResolver(reader).resolve(request.target.point_id)
        if resolution.needs_input:
            raise SkillNeedsInputError(
                resolution.needs_input_reason or "target resolution needs input"
            )
        target_error = v07_target_compatibility_error(reader, resolution)
        if target_error is not None:
            raise SkillNeedsInputError(target_error)
        point_id = resolution.source_target_point_id
        source_partition = resolution.source_partition
        if point_id is None or source_partition is None:
            raise AssertionError("successful target resolution is incomplete")
        point = reader.points[point_id]
        if point.unit not in {None, "kW"}:
            raise SkillNeedsInputError(
                f"target unit must be kW for current Skill 4 compatibility, "
                f"got {point.unit!r}"
            )

        table = reader.read_point_timeseries(point_id, source_partition)
        _validate_target_table(table, point_id)
        grid = build_target_grid(
            table["timestamp"].to_pylist(),
            table["value_raw"].to_pylist(),
        )
        if grid.needs_input:
            raise SkillNeedsInputError(
                grid.needs_input_reason or "target grid needs input"
            )
        days = summarize_calendar_days(grid.rows, timezone.key)
        date_split = split_valid_days(days)
        if date_split.needs_input:
            raise SkillNeedsInputError(
                date_split.needs_input_reason or "date split needs input"
            )
        sample_plan = build_sample_plan(
            grid.rows,
            days,
            date_split,
            timezone.key,
            anchor_time,
            horizon_minutes,
        )

        feature_catalog = tuple(
            FeatureCatalogEntry(
                feature_name=name,
                data_type=data_type,
                source_point_id=point_id,
                semantic_version=semantic_version,
            )
            for name, data_type, semantic_version in FEATURE_DEFINITIONS
        )
        (
            features,
            forecast_index,
            labels,
            history_exclusions,
        ) = _build_model_rows(
            grid.rows,
            sample_plan.rows,
            timezone,
            horizon_minutes,
        )
        for split in ("train", "validation", "test"):
            if not features[split]:
                raise SkillNeedsInputError(
                    f"no eligible {split} sample remains after 24h history checks"
                )

        split_manifest = _split_manifest(
            features,
            requested_ratio={"train": 0.7, "validation": 0.2, "test": 0.1},
            valid_day_count=sum(day.valid for day in days),
        )
        warnings = tuple(grid.warnings)
        report = {
            "status": "succeeded",
            "source_bundle_id": request.source_bundle_id,
            "source_target_point_id": point_id,
            "feature_rule_version": FEATURE_RULE_VERSION,
            "history_minutes": HISTORY_MINUTES,
            "horizon_minutes": horizon_minutes,
            "local_timezone": timezone.key,
            "anchor_time": anchor_time_text,
            "grid_row_count": len(grid.rows),
            "valid_day_count": sum(day.valid for day in days),
            "invalid_day_count": sum(not day.valid for day in days),
            "sample_plan_count": len(sample_plan.rows),
            "eligible_sample_count": sum(len(rows) for rows in features.values()),
            "sample_plan_exclusion_counts": sample_plan.exclusion_reason_counts,
            "history_exclusion_counts": dict(sorted(history_exclusions.items())),
            "warnings": list(warnings),
        }
        processed_timeseries = tuple(
            {
                "timestamp": row.timestamp,
                "target_value": (
                    None if row.target_value is None else float(row.target_value)
                ),
                "is_observed": row.is_observed,
                "gap_class": row.gap_class,
                "segment_id": row.segment_id,
            }
            for row in grid.rows
        )
        bundle = self.writer.write(
            ProcessingBundleWriteRequest(
                mode="backtest",
                source_bundle_id=request.source_bundle_id,
                feature_catalog=feature_catalog,
                target_metadata=TargetMetadata(
                    source_target_point_id=point_id,
                ),
                categorical_mappings={},
                features=features,
                forecast_index=forecast_index,
                labels=labels,
                split_manifest=split_manifest,
                processing_report=report,
                processed_timeseries=processed_timeseries,
                leakage_check_rule_version="strict-exclusive-cutoff-v1",
                processing_rule_version="processing-v0.7",
                data_granularity="1min",
            )
        )
        summary = {
            "mode": "backtest",
            "source_bundle_id": request.source_bundle_id,
            "source_target_point_id": point_id,
            "feature_rule_version": FEATURE_RULE_VERSION,
            "horizon_minutes": horizon_minutes,
            "split_sample_counts": bundle.split_sample_counts,
            "forecast_index_row_count": bundle.forecast_index_row_count,
            "label_row_count": bundle.label_row_count,
            "warning_count": len(warnings),
        }
        return Skill2PipelineOutcome(bundle=bundle, summary=summary, warnings=warnings)


def _build_model_rows(
    grid_rows: tuple[TargetGridRow, ...],
    sample_rows: tuple[SamplePlanRow, ...],
    timezone: ZoneInfo,
    horizon_minutes: int,
) -> tuple[
    dict[str, list[FeatureSetRow]],
    dict[str, list[ForecastIndexRow]],
    dict[str, list[LabelSetRow]],
    Counter[str],
]:
    grid_by_timestamp = {row.timestamp: row for row in grid_rows}
    features: dict[str, list[FeatureSetRow]] = {
        "train": [],
        "validation": [],
        "test": [],
    }
    forecast_index: dict[str, list[ForecastIndexRow]] = {
        "train": [],
        "validation": [],
        "test": [],
    }
    labels: dict[str, list[LabelSetRow]] = {
        "train": [],
        "validation": [],
        "test": [],
    }
    exclusions: Counter[str] = Counter()

    for sample in sample_rows:
        if not sample.eligible:
            continue
        history = [
            grid_by_timestamp.get(
                sample.feature_cutoff_timestamp - offset * GRID_STEP
            )
            for offset in range(1, HISTORY_MINUTES + 1)
        ]
        if any(row is None for row in history):
            exclusions["insufficient_24h_history"] += 1
            continue
        present_history = [row for row in history if row is not None]
        if any(
            row.target_value is None or row.segment_id != sample.segment_id
            for row in present_history
        ):
            exclusions["incomplete_or_cross_segment_24h_history"] += 1
            continue
        history_values = [float(row.target_value) for row in present_history]
        feature = FeatureSetRow(
            sample_id=sample.sample_id,
            feature_cutoff_timestamp=sample.feature_cutoff_timestamp,
            forecast_start_timestamp=sample.forecast_start_timestamp,
            forecast_end_timestamp=sample.forecast_end_timestamp,
            target_lag_1min=history_values[0],
            target_lag_60min=history_values[59],
            target_lag_1440min=history_values[1_439],
            target_mean_60min=sum(history_values[:60]) / 60,
            target_mean_1440min=sum(history_values) / HISTORY_MINUTES,
        )
        horizon = build_horizon(
            sample.forecast_start_timestamp,
            horizon_minutes,
        )
        sample_index: list[ForecastIndexRow] = []
        sample_labels: list[LabelSetRow] = []
        missing_target = False
        for step in horizon:
            target_row = grid_by_timestamp.get(step.target_timestamp)
            if target_row is None:
                missing_target = True
                break
            local_target = step.target_timestamp.astimezone(timezone)
            sample_index.append(
                ForecastIndexRow(
                    sample_id=sample.sample_id,
                    target_timestamp=step.target_timestamp,
                    horizon_step=step.horizon_step,
                    horizon_duration=f"{step.horizon_step - 1}min",
                    calendar_hour=local_target.hour,
                    calendar_weekday=local_target.weekday(),
                    calendar_month=local_target.month,
                )
            )
            sample_labels.append(
                LabelSetRow(
                    sample_id=sample.sample_id,
                    target_timestamp=step.target_timestamp,
                    target_value=target_row.target_value,
                )
            )
        if missing_target:
            exclusions["forecast_outside_target_grid"] += 1
            continue
        features[sample.split].append(feature)
        forecast_index[sample.split].extend(sample_index)
        labels[sample.split].extend(sample_labels)
    return features, forecast_index, labels, exclusions


def _split_manifest(
    features: dict[str, list[FeatureSetRow]],
    *,
    requested_ratio: dict[str, float],
    valid_day_count: int,
) -> dict[str, Any]:
    total = sum(len(rows) for rows in features.values())
    splits: dict[str, Any] = {}
    for split, rows in features.items():
        starts = [row.forecast_start_timestamp for row in rows]
        ends = [row.forecast_end_timestamp for row in rows]
        splits[split] = {
            "sample_count": len(rows),
            "actual_ratio": len(rows) / total if total else 0.0,
            "forecast_start": min(starts).isoformat() if starts else None,
            "forecast_end": max(ends).isoformat() if ends else None,
        }
    return {
        "requested_ratio": requested_ratio,
        "valid_day_count": valid_day_count,
        "eligible_sample_count": total,
        "splits": splits,
    }


def _string_setting(
    values: dict[str, Any],
    key: str,
    default: str,
) -> str:
    value = values.get(key, default)
    if not isinstance(value, str) or not value:
        raise SkillNeedsInputError(f"{key} must be a non-empty string")
    return value
