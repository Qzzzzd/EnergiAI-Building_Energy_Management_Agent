"""Strict backtest feature pipeline for Skill 2."""

from __future__ import annotations

from bisect import bisect_left
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from math import sqrt
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
    OperatingWindow,
    TargetGridRow,
    build_target_grid,
    infer_operating_window,
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


LEGACY_FEATURE_RULE_VERSION = "target-history-v1"
FEATURE_RULE_VERSION = "building-energy-history-v2"
PROCESSING_RULE_VERSION = "processing-v0.7-known-future-v1"
HISTORY_MINUTES = 1_440
SUPPORTED_PRESETS = {"default", LEGACY_FEATURE_RULE_VERSION, FEATURE_RULE_VERSION}
LEGACY_FEATURE_DEFINITIONS = (
    ("target_lag_1min", "numeric", "lag-1min-v1"),
    ("target_lag_60min", "numeric", "lag-60min-v1"),
    ("target_lag_1440min", "numeric", "lag-1440min-v1"),
    ("target_mean_60min", "numeric", "mean-previous-60min-v1"),
    ("target_mean_1440min", "numeric", "mean-previous-1440min-v1"),
)
TARGET_LAGS = (1, 5, 15, 30, 60, 180, 360, 720, 1_440)
ROLLING_WINDOWS = (15, 60, 180, 360, 1_440)
V2_FEATURE_DEFINITIONS = tuple(
    (f"target_lag_{minutes}min", "numeric", f"lag-{minutes}min-v2")
    for minutes in TARGET_LAGS
) + tuple(
    (f"target_{stat}_{minutes}min", "numeric", f"{stat}-{minutes}min-v2")
    for minutes in ROLLING_WINDOWS
    for stat in ("mean", "std", "min", "max")
) + tuple(
    (f"target_delta_{minutes}min", "numeric", f"delta-{minutes}min-v2")
    for minutes in (15, 60, 180)
)
PREVIOUS_WINDOW_FEATURE_DEFINITIONS = (
    (
        "target_prev_day_window_mean",
        "numeric",
        "previous-operating-window-mean-v1",
    ),
    (
        "target_prev_day_window_std",
        "numeric",
        "previous-operating-window-std-v1",
    ),
    (
        "target_prev_day_window_peak",
        "numeric",
        "previous-operating-window-peak-v1",
    ),
    (
        "target_prev_day_operating_ratio",
        "numeric",
        "previous-operating-window-state-ratio-v1",
    ),
)


def _operating_window_minutes(window: OperatingWindow) -> int:
    start = window[0].hour * 60 + window[0].minute
    end = window[1].hour * 60 + window[1].minute
    if end <= start:
        raise ValueError("operating window must end after it starts")
    return end - start


def _format_time(value: time) -> str:
    return f"{value.hour:02d}:{value.minute:02d}"


def _v2_feature_definitions(
    granularity_minutes: int,
    horizon_steps: int = 1_440,
    history_minutes: int = HISTORY_MINUTES,
) -> tuple[tuple[str, str, str], ...]:
    """Return only time windows representable at the source granularity."""

    definitions: list[tuple[str, str, str]] = []
    for minutes in TARGET_LAGS:
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            definitions.append(
                (f"target_lag_{minutes}min", "numeric", f"lag-{minutes}min-v2")
            )
    for minutes in ROLLING_WINDOWS:
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            definitions.extend(
                (
                    (f"target_{stat}_{minutes}min", "numeric", f"{stat}-{minutes}min-v2")
                    for stat in ("mean", "std", "min", "max")
                )
            )
    for minutes in (15, 60, 180):
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            definitions.append(
                (f"target_delta_{minutes}min", "numeric", f"delta-{minutes}min-v2")
            )
    definitions.extend(PREVIOUS_WINDOW_FEATURE_DEFINITIONS)
    profile_label = f"{history_minutes}min"
    definitions.extend(
        (
            f"target_profile_lag_{profile_label}_step_{step}",
            "numeric",
            f"previous-operating-window-profile-{profile_label}-v1",
        )
        for step in range(1, horizon_steps + 1)
    )
    return tuple(definitions)


@dataclass(frozen=True, slots=True)
class Skill2PipelineOutcome:
    bundle: ProcessingBundleWriteOutcome
    summary: dict[str, Any]
    warnings: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ExogenousHistory:
    feature_prefix: str
    point_id: str
    display_name: str
    variable_type: str
    timestamps: tuple[datetime, ...]
    values: tuple[float | None, ...]
    availability: str = "historical_only"


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
        feature_rule_version = (
            LEGACY_FEATURE_RULE_VERSION
            if request.feature_spec.preset == LEGACY_FEATURE_RULE_VERSION
            else FEATURE_RULE_VERSION
        )
        local_timezone = _string_setting(
            request.data_scope,
            "local_timezone",
            "Asia/Shanghai",
        )
        processing_mode = _string_setting(
            request.data_scope,
            "processing_mode",
            "backtest",
        )
        if processing_mode not in {"backtest", "future"}:
            raise SkillNeedsInputError(
                "processing_mode must be either 'backtest' or 'future'"
            )
        anchor_time_text = _string_setting(
            request.split_spec,
            "anchor_time",
            "00:00",
        )
        interval_value = request.split_spec.get("origin_interval_minutes")
        if interval_value is None and (
            feature_rule_version != LEGACY_FEATURE_RULE_VERSION
            or "anchor_time" not in request.split_spec
        ):
            interval_value = 60
        if interval_value is not None and (
            not isinstance(interval_value, int)
            or isinstance(interval_value, bool)
            or not 1 <= interval_value <= 1_440
        ):
            raise SkillNeedsInputError(
                "origin_interval_minutes must be an integer between 1 and 1440"
            )
        try:
            timezone = ZoneInfo(local_timezone)
            anchor_time = parse_anchor_time(anchor_time_text)
            horizon_minutes = parse_forecast_horizon(
                request.prediction_spec.forecast_horizon
            )
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise SkillNeedsInputError(str(exc)) from exc
        requested_horizon_minutes = horizon_minutes

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
        target_candidate = next(
            (candidate for candidate in resolution.candidates if candidate.point_id == point_id),
            None,
        )
        target_name = (
            (target_candidate.original_column_name if target_candidate else "")
            or point.name
            or point.description
            or point_id
        )
        target_unit = point.unit.strip() if isinstance(point.unit, str) and point.unit.strip() else "unknown"
        target_warnings = (
            ()
            if target_unit != "unknown"
            else ("target unit is missing; range conclusions require a domain rule",)
        )
        interval_seconds = point.expected_interval_seconds
        if interval_seconds is None or interval_seconds <= 0 or interval_seconds % 60:
            raise SkillNeedsInputError(
                "target expected interval must be a positive whole-minute value"
            )
        granularity_minutes = interval_seconds // 60
        if 1_440 % granularity_minutes:
            raise SkillNeedsInputError(
                "target granularity must divide a 24-hour day"
            )
        grid_step = timedelta(minutes=granularity_minutes)
        if feature_rule_version == LEGACY_FEATURE_RULE_VERSION:
            if granularity_minutes != 1:
                raise SkillNeedsInputError(
                    "target-history-v1 requires one-minute source data"
                )
        exogenous_histories = (
            ()
            if feature_rule_version == LEGACY_FEATURE_RULE_VERSION
            else _load_exogenous_histories(
                reader,
                point_id,
                request.feature_spec.known_future_point_ids,
            )
        )

        table = reader.read_point_timeseries(point_id, source_partition)
        _validate_target_table(table, point_id)
        grid = build_target_grid(
            table["timestamp"].to_pylist(),
            table["value_raw"].to_pylist(),
            grid_step,
        )
        if grid.needs_input:
            raise SkillNeedsInputError(
                grid.needs_input_reason or "target grid needs input"
            )
        negative_target_count = sum(
            row.target_value is not None and float(row.target_value) < 0
            for row in grid.rows
        )
        negative_target_warnings = (
            (
                f"target contains {negative_target_count} negative observation(s); "
                "labels were preserved and were not clipped",
            )
            if negative_target_count and target_unit.casefold() == "kw"
            else ()
        )
        days = summarize_calendar_days(
            grid.rows,
            timezone.key,
            rows_per_day=1_440 // granularity_minutes,
            row_interval_minutes=granularity_minutes,
        )
        operating_window: OperatingWindow | None = None
        history_minutes = HISTORY_MINUTES
        adaptive_warnings: tuple[str, ...] = ()
        if not any(day.valid for day in days):
            operating_window = infer_operating_window(
                grid.rows,
                timezone.key,
                row_interval_minutes=granularity_minutes,
            )
            if operating_window is not None:
                days = summarize_calendar_days(
                    grid.rows,
                    timezone.key,
                    rows_per_day=1_440 // granularity_minutes,
                    row_interval_minutes=granularity_minutes,
                    operating_window=operating_window,
                )
                history_minutes = _operating_window_minutes(operating_window)
                anchor_time = operating_window[0]
                anchor_time_text = _format_time(anchor_time)
                if horizon_minutes > history_minutes:
                    adaptive_warnings = (
                        f"detected a {history_minutes // 60}h operating window; "
                        f"forecast horizon adjusted from {horizon_minutes}min "
                        f"to {history_minutes}min",
                    )
                    horizon_minutes = history_minutes
        history_steps = history_minutes // granularity_minutes
        if feature_rule_version == LEGACY_FEATURE_RULE_VERSION:
            feature_definitions = LEGACY_FEATURE_DEFINITIONS
        else:
            feature_definitions = _v2_feature_definitions(
                granularity_minutes,
                horizon_minutes // granularity_minutes,
                history_minutes=history_minutes,
            )
        feature_catalog = tuple(
            FeatureCatalogEntry(
                feature_name=name,
                data_type=data_type,
                source_point_id=point_id,
                semantic_version=semantic_version,
            )
            for name, data_type, semantic_version in feature_definitions
        ) + _exogenous_feature_catalog(exogenous_histories)
        if processing_mode == "future":
            return self._run_future(
                request=request,
                point=point,
                point_id=point_id,
                target_name=target_name,
                target_unit=target_unit,
                target_warnings=(
                    *target_warnings,
                    *adaptive_warnings,
                    *negative_target_warnings,
                ),
                grid_rows=grid.rows,
                grid_warnings=grid.warnings,
                feature_catalog=feature_catalog,
                feature_rule_version=feature_rule_version,
                exogenous_histories=exogenous_histories,
                timezone=timezone,
                horizon_minutes=horizon_minutes,
                requested_horizon_minutes=requested_horizon_minutes,
                grid_step=grid_step,
                history_steps=history_steps,
                granularity_minutes=granularity_minutes,
                history_minutes=history_minutes,
                operating_window=operating_window,
            )
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
            origin_interval_minutes=interval_value,
            grid_step=grid_step,
        )

        future_exog_stats: Counter[str] = Counter()
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
            feature_rule_version,
            exogenous_histories,
            grid_step,
            history_steps,
            granularity_minutes,
            history_minutes,
            future_exog_stats,
            operating_window=operating_window,
        )
        for split in ("train", "validation", "test"):
            if not features[split]:
                raise SkillNeedsInputError(
                    f"no eligible {split} sample remains after {history_minutes}min history checks"
                )

        split_manifest = _split_manifest(
            features,
            requested_ratio={"train": 0.7, "validation": 0.2, "test": 0.1},
            valid_day_count=sum(day.valid for day in days),
        )
        warnings = (
            *target_warnings,
            *adaptive_warnings,
            *negative_target_warnings,
            *grid.warnings,
        )
        report = {
            "status": "succeeded",
            "source_bundle_id": request.source_bundle_id,
            "source_target_point_id": point_id,
            "feature_rule_version": feature_rule_version,
            "target_operating_state_rule": (
                "heuristic: load > 5% of previous full-window peak; "
                "confirm zero/16 semantics before production use"
            ),
            "history_minutes": history_minutes,
            "data_granularity": f"{granularity_minutes}min",
            "requested_horizon_minutes": requested_horizon_minutes,
            "horizon_minutes": horizon_minutes,
            "local_timezone": timezone.key,
            "anchor_time": anchor_time_text,
            "operating_window": (
                {
                    "start": _format_time(operating_window[0]),
                    "end": _format_time(operating_window[1]),
                }
                if operating_window is not None
                else None
            ),
            "origin_interval_minutes": interval_value,
            "grid_row_count": len(grid.rows),
            "valid_day_count": sum(day.valid for day in days),
            "invalid_day_count": sum(not day.valid for day in days),
            "sample_plan_count": len(sample_plan.rows),
            "eligible_sample_count": sum(len(rows) for rows in features.values()),
            "negative_target_count": negative_target_count,
            "sample_plan_exclusion_counts": sample_plan.exclusion_reason_counts,
            "history_exclusion_counts": dict(sorted(history_exclusions.items())),
            "forecast_known_future_features": [
                f"future_{history.feature_prefix}_value"
                for history in exogenous_histories
                if history.availability == "known_future"
            ],
            "future_exogenous_value_counts": dict(sorted(future_exog_stats.items())),
            "exogenous_features": [
                {
                    "feature_prefix": history.feature_prefix,
                    "source_point_id": history.point_id,
                    "display_name": history.display_name,
                    "variable_type": history.variable_type,
                    "availability": history.availability,
                }
                for history in exogenous_histories
            ],
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
                    target_point_id=point_id,
                    target_name=target_name,
                    target_unit=target_unit,
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
                processing_rule_version=(
                    PROCESSING_RULE_VERSION
                    if feature_rule_version != LEGACY_FEATURE_RULE_VERSION
                    else "processing-v0.7"
                ),
                data_granularity=f"{granularity_minutes}min",
            )
        )
        summary = {
            "mode": "backtest",
            "source_bundle_id": request.source_bundle_id,
            "source_target_point_id": point_id,
            "feature_rule_version": feature_rule_version,
            "requested_horizon_minutes": requested_horizon_minutes,
            "horizon_minutes": horizon_minutes,
            "split_sample_counts": bundle.split_sample_counts,
            "forecast_index_row_count": bundle.forecast_index_row_count,
            "label_row_count": bundle.label_row_count,
            "warning_count": len(warnings),
        }
        return Skill2PipelineOutcome(bundle=bundle, summary=summary, warnings=warnings)

    def _run_future(
        self,
        *,
        request: ProcessingSpec,
        point: Any,
        point_id: str,
        target_name: str,
        target_unit: str,
        target_warnings: tuple[str, ...],
        grid_rows: tuple[TargetGridRow, ...],
        grid_warnings: tuple[str, ...],
        feature_catalog: tuple[FeatureCatalogEntry, ...],
        feature_rule_version: str,
        exogenous_histories: tuple[ExogenousHistory, ...],
        timezone: ZoneInfo,
        horizon_minutes: int,
        requested_horizon_minutes: int,
        grid_step: timedelta,
        history_steps: int,
        granularity_minutes: int,
        history_minutes: int,
        operating_window: OperatingWindow | None,
    ) -> Skill2PipelineOutcome:
        future_exog_stats: Counter[str] = Counter()
        feature, index = _build_future_rows(
            grid_rows,
            timezone,
            horizon_minutes,
            feature_rule_version,
            exogenous_histories,
            grid_step,
            history_steps,
            granularity_minutes,
            history_minutes,
            operating_window,
            future_exog_stats,
        )
        warnings = (*target_warnings, *grid_warnings)
        report = {
            "status": "succeeded",
            "mode": "future",
            "source_bundle_id": request.source_bundle_id,
            "source_target_point_id": point_id,
            "feature_rule_version": feature_rule_version,
            "target_operating_state_rule": (
                "heuristic: load > 5% of previous full-window peak; "
                "confirm zero/16 semantics before production use"
            ),
            "history_minutes": history_minutes,
            "requested_horizon_minutes": requested_horizon_minutes,
            "horizon_minutes": horizon_minutes,
            "data_granularity": f"{granularity_minutes}min",
            "local_timezone": timezone.key,
            "forecast_start": feature.forecast_start_timestamp.isoformat(),
            "forecast_end": feature.forecast_end_timestamp.isoformat(),
            "forecast_known_future_features": [
                f"future_{history.feature_prefix}_value"
                for history in exogenous_histories
                if history.availability == "known_future"
            ],
            "future_exogenous_value_counts": dict(sorted(future_exog_stats.items())),
            "operating_window": (
                {
                    "start": _format_time(operating_window[0]),
                    "end": _format_time(operating_window[1]),
                }
                if operating_window is not None
                else None
            ),
            "warnings": list(warnings),
        }
        bundle = self.writer.write(
            ProcessingBundleWriteRequest(
                mode="future",
                source_bundle_id=request.source_bundle_id,
                feature_catalog=feature_catalog,
                target_metadata=TargetMetadata(
                    target_point_id=point_id,
                    target_name=target_name,
                    target_unit=target_unit,
                    source_target_point_id=point_id,
                ),
                categorical_mappings={},
                features={"future": [feature]},
                forecast_index={"future": index},
                labels={},
                split_manifest={
                    "mode": "future",
                    "eligible_sample_count": 1,
                    "splits": {
                        "future": {
                            "sample_count": 1,
                            "forecast_start": feature.forecast_start_timestamp.isoformat(),
                            "forecast_end": feature.forecast_end_timestamp.isoformat(),
                        }
                    },
                },
                processing_report=report,
                processed_timeseries=tuple(
                    {
                        "timestamp": row.timestamp,
                        "target_value": (
                            None if row.target_value is None else float(row.target_value)
                        ),
                        "is_observed": row.is_observed,
                        "gap_class": row.gap_class,
                        "segment_id": row.segment_id,
                    }
                    for row in grid_rows
                ),
                leakage_check_rule_version="strict-exclusive-cutoff-v1",
                processing_rule_version=(
                    PROCESSING_RULE_VERSION
                    if feature_rule_version != LEGACY_FEATURE_RULE_VERSION
                    else "processing-v0.7"
                ),
                data_granularity=f"{granularity_minutes}min",
            )
        )
        return Skill2PipelineOutcome(
            bundle=bundle,
            summary={
                "mode": "future",
                "source_bundle_id": request.source_bundle_id,
                "source_target_point_id": point_id,
                "feature_rule_version": feature_rule_version,
                "requested_horizon_minutes": requested_horizon_minutes,
                "horizon_minutes": horizon_minutes,
                "forecast_start": feature.forecast_start_timestamp.isoformat(),
                "forecast_end": feature.forecast_end_timestamp.isoformat(),
                "forecast_index_row_count": bundle.forecast_index_row_count,
                "warning_count": len(warnings),
            },
            warnings=warnings,
        )


def _build_future_rows(
    grid_rows: tuple[TargetGridRow, ...],
    timezone: ZoneInfo,
    horizon_minutes: int,
    feature_rule_version: str,
    exogenous_histories: tuple[ExogenousHistory, ...],
    grid_step: timedelta,
    history_steps: int,
    granularity_minutes: int,
    history_minutes: int,
    operating_window: OperatingWindow | None,
    future_exog_stats: Counter[str] | None = None,
) -> tuple[FeatureSetRow, list[ForecastIndexRow]]:
    if not grid_rows:
        raise SkillNeedsInputError("target grid is empty")
    grid_by_timestamp = {row.timestamp: row for row in grid_rows}
    last_row = grid_rows[-1]
    if operating_window is None:
        forecast_start = last_row.timestamp + grid_step
        history = [
            grid_by_timestamp.get(forecast_start - offset * grid_step)
            for offset in range(1, history_steps + 1)
        ]
    else:
        last_local_day = last_row.timestamp.astimezone(timezone).date()
        next_local_day = last_local_day + timedelta(days=1)
        forecast_start = datetime.combine(
            next_local_day,
            operating_window[0],
            timezone,
        ).astimezone(UTC)
        history = [
            row
            for row in reversed(grid_rows)
            if row.is_observed
            and row.target_value is not None
            and row.segment_id == last_row.segment_id
        ][:history_steps]
    if len(history) != history_steps or any(row is None for row in history):
        raise SkillNeedsInputError(
            f"future prediction requires {history_minutes} complete minutes of target history"
        )
    present = [row for row in history if row is not None]
    if any(
        row.target_value is None or row.segment_id != last_row.segment_id
        for row in present
    ):
        raise SkillNeedsInputError(
            "future prediction requires complete target history in one segment"
        )
    history_values = [float(row.target_value) for row in present]
    feature_values = (
        _legacy_target_features(history_values)
        if feature_rule_version == LEGACY_FEATURE_RULE_VERSION
        else _v2_target_features(
            history_values,
            granularity_minutes,
            horizon_minutes // granularity_minutes,
            history_minutes=history_minutes,
            previous_window_values=_previous_operating_window_values(
                grid_by_timestamp,
                forecast_start,
                timezone,
                operating_window,
                last_row.segment_id,
            ),
        )
    )
    if feature_rule_version != LEGACY_FEATURE_RULE_VERSION:
        feature_values.update(
            _exogenous_features(exogenous_histories, forecast_start)
        )
    horizon = build_horizon(forecast_start, horizon_minutes, grid_step)
    forecast_end = horizon[-1].target_timestamp
    sample_id = (
        f"future-{forecast_start:%Y%m%dT%H%M}-h{horizon_minutes:04d}"
    )
    feature = FeatureSetRow(
        sample_id=sample_id,
        feature_cutoff_timestamp=forecast_start,
        forecast_start_timestamp=forecast_start,
        forecast_end_timestamp=forecast_end,
        **feature_values,
    )
    index: list[ForecastIndexRow] = []
    for step in horizon:
        local_target = step.target_timestamp.astimezone(timezone)
        future_values = _future_exogenous_features(
            exogenous_histories,
            step.target_timestamp,
            future_exog_stats,
        )
        index.append(
            ForecastIndexRow(
                sample_id=sample_id,
                target_timestamp=step.target_timestamp,
                horizon_step=step.horizon_step,
                horizon_duration=(
                    f"{(step.horizon_step - 1) * granularity_minutes}min"
                ),
                calendar_hour=local_target.hour,
                calendar_weekday=local_target.weekday(),
                calendar_month=local_target.month,
                **future_values,
            )
        )
    missing_future = [
        name
        for row in index
        for name, value in (row.model_extra or {}).items()
        if value is None
    ]
    if missing_future:
        raise SkillNeedsInputError(
            "future known-weather values are incomplete for the requested forecast interval: "
            + ", ".join(sorted(set(missing_future)))
        )
    return feature, index


def _build_model_rows(
    grid_rows: tuple[TargetGridRow, ...],
    sample_rows: tuple[SamplePlanRow, ...],
    timezone: ZoneInfo,
    horizon_minutes: int,
    feature_rule_version: str,
    exogenous_histories: tuple[ExogenousHistory, ...] = (),
    grid_step: timedelta = GRID_STEP,
    history_steps: int = HISTORY_MINUTES,
    granularity_minutes: int = 1,
    history_minutes: int = HISTORY_MINUTES,
    future_exog_stats: Counter[str] | None = None,
    operating_window: OperatingWindow | None = None,
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
        if sample.history_timestamps:
            history = [
                grid_by_timestamp.get(timestamp)
                for timestamp in sample.history_timestamps[:history_steps]
            ]
            expected_segment_id = sample.history_segment_id
        else:
            history = [
                grid_by_timestamp.get(
                    sample.feature_cutoff_timestamp - offset * grid_step
                )
                for offset in range(1, history_steps + 1)
            ]
            expected_segment_id = sample.segment_id
        if len(history) != history_steps or any(row is None for row in history):
            exclusions["insufficient_history"] += 1
            continue
        present_history = [row for row in history if row is not None]
        if any(
            row.target_value is None or row.segment_id != expected_segment_id
            for row in present_history
        ):
            exclusions["incomplete_or_cross_segment_history"] += 1
            continue
        history_values = [float(row.target_value) for row in present_history]
        feature_values = (
            _legacy_target_features(history_values)
            if feature_rule_version == LEGACY_FEATURE_RULE_VERSION
            else _v2_target_features(
                history_values,
                granularity_minutes,
                horizon_minutes // granularity_minutes,
                history_minutes=history_minutes,
                previous_window_values=_previous_operating_window_values(
                    grid_by_timestamp,
                    sample.forecast_start_timestamp,
                    timezone,
                    operating_window,
                    expected_segment_id,
                ),
            )
        )
        if feature_rule_version != LEGACY_FEATURE_RULE_VERSION:
            feature_values.update(
                _exogenous_features(
                    exogenous_histories,
                    sample.feature_cutoff_timestamp,
                )
            )
        feature = FeatureSetRow(
            sample_id=sample.sample_id,
            feature_cutoff_timestamp=sample.feature_cutoff_timestamp,
            forecast_start_timestamp=sample.forecast_start_timestamp,
            forecast_end_timestamp=sample.forecast_end_timestamp,
            **feature_values,
        )
        horizon = build_horizon(
            sample.forecast_start_timestamp,
            horizon_minutes,
            grid_step,
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
            future_values = _future_exogenous_features(
                exogenous_histories,
                step.target_timestamp,
                future_exog_stats,
            )
            sample_index.append(
                ForecastIndexRow(
                    sample_id=sample.sample_id,
                    target_timestamp=step.target_timestamp,
                    horizon_step=step.horizon_step,
                    horizon_duration=(
                        f"{(step.horizon_step - 1) * granularity_minutes}min"
                    ),
                    calendar_hour=local_target.hour,
                    calendar_weekday=local_target.weekday(),
                    calendar_month=local_target.month,
                    **future_values,
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


def _legacy_target_features(history_values: list[float]) -> dict[str, float]:
    return {
        "target_lag_1min": history_values[0],
        "target_lag_60min": history_values[59],
        "target_lag_1440min": history_values[1_439],
        "target_mean_60min": sum(history_values[:60]) / 60,
        "target_mean_1440min": sum(history_values) / HISTORY_MINUTES,
    }


def _previous_operating_window_values(
    grid_by_timestamp: dict[datetime, TargetGridRow],
    forecast_start_timestamp: datetime,
    timezone: ZoneInfo,
    operating_window: OperatingWindow | None,
    segment_id: int | float | None,
) -> list[float]:
    if operating_window is None:
        return []
    previous_date = forecast_start_timestamp.astimezone(timezone).date() - timedelta(
        days=1
    )
    start_minutes = operating_window[0].hour * 60 + operating_window[0].minute
    end_minutes = operating_window[1].hour * 60 + operating_window[1].minute
    values: list[tuple[datetime, float]] = []
    for row in grid_by_timestamp.values():
        if (
            not row.is_observed
            or row.target_value is None
            or row.segment_id != segment_id
        ):
            continue
        local = row.timestamp.astimezone(timezone)
        local_minutes = local.hour * 60 + local.minute
        if previous_date == local.date() and start_minutes <= local_minutes < end_minutes:
            values.append((row.timestamp, float(row.target_value)))
    return [value for _, value in sorted(values, key=lambda item: item[0])]


def _v2_target_features(
    history_values: list[float],
    granularity_minutes: int = 1,
    horizon_steps: int = 1_440,
    history_minutes: int = HISTORY_MINUTES,
    previous_window_values: list[float] | None = None,
) -> dict[str, float]:
    def steps(minutes: int) -> int:
        if minutes % granularity_minutes:
            raise ValueError("feature window is not representable at source granularity")
        return minutes // granularity_minutes

    values = {
        f"target_lag_{minutes}min": history_values[steps(minutes) - 1]
        for minutes in TARGET_LAGS
        if minutes <= history_minutes and minutes % granularity_minutes == 0
    }
    for minutes in ROLLING_WINDOWS:
        if minutes > history_minutes or minutes % granularity_minutes:
            continue
        window_steps = steps(minutes)
        window = history_values[:window_steps]
        mean = sum(window) / window_steps
        variance = sum((value - mean) ** 2 for value in window) / window_steps
        values.update(
            {
                f"target_mean_{minutes}min": mean,
                f"target_std_{minutes}min": sqrt(variance),
                f"target_min_{minutes}min": min(window),
                f"target_max_{minutes}min": max(window),
            }
        )
    for minutes in (15, 60, 180):
        if minutes <= history_minutes and minutes % granularity_minutes == 0:
            values[f"target_delta_{minutes}min"] = (
                history_values[0] - history_values[steps(minutes) - 1]
            )
    finite_values = [
        value
        for value in (previous_window_values or history_values)
        if value == value
    ]
    if finite_values:
        window_mean = sum(finite_values) / len(finite_values)
        variance = sum((value - window_mean) ** 2 for value in finite_values) / len(
            finite_values
        )
        window_peak = max(finite_values)
        positive_peak = max((value for value in finite_values if value > 0), default=0.0)
        state_threshold = positive_peak * 0.05
        operating_ratio = (
            sum(value > state_threshold for value in finite_values) / len(finite_values)
            if positive_peak > 0
            else 0.0
        )
        values.update(
            {
                "target_prev_day_window_mean": window_mean,
                "target_prev_day_window_std": sqrt(variance),
                "target_prev_day_window_peak": window_peak,
                "target_prev_day_operating_ratio": operating_ratio,
            }
        )
    if previous_window_values:
        values.update(
            {
                f"target_profile_lag_{history_minutes}min_step_{step}": previous_window_values[
                    (step - 1) % len(previous_window_values)
                ]
                for step in range(1, horizon_steps + 1)
            }
        )
    else:
        history_steps = history_minutes // granularity_minutes
        values.update(
            {
                f"target_profile_lag_{history_minutes}min_step_{step}": history_values[
                    history_steps - 1 - ((step - 1) % history_steps)
                ]
                for step in range(1, horizon_steps + 1)
            }
        )
    return values


def _load_exogenous_histories(
    reader: DatasetBundleReader,
    target_point_id: str,
    known_future_point_ids: list[str] | None = None,
) -> tuple[ExogenousHistory, ...]:
    histories: list[ExogenousHistory] = []
    requested_future_ids = set(known_future_point_ids or [])
    unknown_future_ids = sorted(
        (requested_future_ids - set(reader.points))
        | (requested_future_ids & {target_point_id})
    )
    if unknown_future_ids:
        raise SkillNeedsInputError(
            "known_future_point_ids must refer to non-target DatasetBundle points: "
            + ", ".join(unknown_future_ids)
        )
    candidate_ids = sorted(
        point_id
        for point_id, point in reader.points.items()
        if point_id != target_point_id
        and point.variable_type in {"continuous", "state"}
    )
    for ordinal, point_id in enumerate(candidate_ids, start=1):
        partitions = reader.point_partitions(point_id)
        if len(partitions) != 1:
            continue
        table = reader.read_point_timeseries(point_id, partitions[0])
        rows = sorted(table.to_pylist(), key=lambda row: row["timestamp"])
        point = reader.points[point_id]
        availability = (
            "known_future"
            if point_id in requested_future_ids or _looks_like_weather(point_id, point)
            else "historical_only"
        )
        histories.append(
            ExogenousHistory(
                feature_prefix=f"exog_{ordinal:02d}",
                point_id=point_id,
                display_name=point.description or point.name or point_id,
                variable_type=point.variable_type,
                timestamps=tuple(row["timestamp"] for row in rows),
                values=tuple(
                    None if row["value_raw"] is None else float(row["value_raw"])
                    for row in rows
                ),
                availability=availability,
            )
        )
    loaded_ids = {history.point_id for history in histories}
    missing_requested = sorted(requested_future_ids - loaded_ids)
    if missing_requested:
        raise SkillNeedsInputError(
            "known_future_point_ids are not available as single-partition numeric series: "
            + ", ".join(missing_requested)
        )
    return tuple(histories)


def _looks_like_weather(point_id: str, point: Any) -> bool:
    text = " ".join(
        str(value or "")
        for value in (
            point_id,
            getattr(point, "name", None),
            getattr(point, "description", None),
        )
    ).casefold()
    if any(
        term in text
        for term in ("冷冻水", "冷却水", "包间", "冷通道", "室内", "机房")
    ):
        return False
    return any(
        term in text
        for term in (
            "dry bulb",
            "wet bulb",
            "solar",
            "radiation",
            "humidity",
            "outdoor",
            "weather",
            "干球",
            "湿球",
            "太阳",
            "辐射",
            "湿度",
            "室外",
            "天气",
        )
    )


def _exogenous_feature_catalog(
    histories: tuple[ExogenousHistory, ...],
) -> tuple[FeatureCatalogEntry, ...]:
    entries: list[FeatureCatalogEntry] = []
    for history in histories:
        suffixes = (
            ("last", "last-known-v2"),
            ("transition_count_1440min", "transition-count-1440min-v2"),
        ) if history.variable_type == "state" else (
            ("last", "last-known-v2"),
            ("mean_60min", "mean-previous-60min-v2"),
            ("mean_1440min", "mean-previous-1440min-v2"),
            ("delta_60min", "delta-previous-60min-v2"),
        )
        entries.extend(
            FeatureCatalogEntry(
                feature_name=f"{history.feature_prefix}_{suffix}",
                data_type="numeric",
                source_point_id=history.point_id,
                semantic_version=semantic_version,
            )
            for suffix, semantic_version in suffixes
        )
    return tuple(entries)


def _exogenous_features(
    histories: tuple[ExogenousHistory, ...],
    cutoff: datetime,
) -> dict[str, float | None]:
    features: dict[str, float | None] = {}
    for history in histories:
        end = bisect_left(history.timestamps, cutoff)
        last = _last_finite(history.values[:end])
        features[f"{history.feature_prefix}_last"] = last
        if history.variable_type == "state":
            start = bisect_left(history.timestamps, cutoff - timedelta(days=1))
            states = [value for value in history.values[start:end] if value is not None]
            features[f"{history.feature_prefix}_transition_count_1440min"] = float(
                sum(left != right for left, right in zip(states, states[1:], strict=False))
            )
            continue
        for minutes in (60, 1_440):
            start = bisect_left(
                history.timestamps,
                cutoff - timedelta(minutes=minutes),
            )
            window = [value for value in history.values[start:end] if value is not None]
            features[f"{history.feature_prefix}_mean_{minutes}min"] = (
                sum(window) / len(window) if window else None
            )
            if minutes == 60:
                features[f"{history.feature_prefix}_delta_60min"] = (
                    window[-1] - window[0] if len(window) >= 2 else None
                )
    return features


def _future_exogenous_features(
    histories: tuple[ExogenousHistory, ...],
    target_timestamp: datetime,
    stats: Counter[str] | None = None,
) -> dict[str, float | None]:
    values: dict[str, float | None] = {}
    for history in histories:
        if history.availability != "known_future":
            continue
        value, status = _known_future_value_with_status(history, target_timestamp)
        values[f"future_{history.feature_prefix}_value"] = value
        if stats is not None:
            stats[status] += 1
    return values


def _known_future_value(
    history: ExogenousHistory,
    target_timestamp: datetime,
) -> float | None:
    value, _ = _known_future_value_with_status(history, target_timestamp)
    return value


def _known_future_value_with_status(
    history: ExogenousHistory,
    target_timestamp: datetime,
) -> tuple[float | None, str]:
    if not history.timestamps:
        return None, "missing"
    position = bisect_left(history.timestamps, target_timestamp)
    if position < len(history.timestamps) and history.timestamps[position] == target_timestamp:
        value = history.values[position]
        if value is not None and _is_finite(value):
            return float(value), "observed"

    left = position - 1
    while left >= 0 and not _finite_optional(history.values[left]):
        left -= 1
    right = position
    while right < len(history.timestamps) and not _finite_optional(history.values[right]):
        right += 1
    if left < 0 or right >= len(history.timestamps):
        return None, "missing"
    left_time = history.timestamps[left]
    right_time = history.timestamps[right]
    if right_time <= left_time:
        return None, "missing"
    left_value = float(history.values[left])
    right_value = float(history.values[right])
    fraction = (target_timestamp - left_time).total_seconds() / (
        right_time - left_time
    ).total_seconds()
    return left_value + fraction * (right_value - left_value), "interpolated"


def _finite_optional(value: float | None) -> bool:
    return value is not None and _is_finite(value)


def _is_finite(value: float) -> bool:
    return value == value and abs(value) != float("inf")


def _last_finite(values: tuple[float | None, ...]) -> float | None:
    return next((value for value in reversed(values) if value is not None), None)


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
