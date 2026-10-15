"""Internal date split and SamplePlan construction for target-grid-v1."""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from math import floor
from pathlib import Path
from typing import Literal, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from building_energy_agent.skills.skill2_processing.preflight import (
    DatasetBundleReader,
    TargetResolver,
    _validate_target_table,
)
from building_energy_agent.skills.skill2_processing.resampling import (
    GRID_STEP,
    CalendarDay,
    TargetGridResult,
    TargetGridRow,
    build_target_grid,
    summarize_calendar_days,
)

SplitName = Literal["train", "validation", "test"]
RULE_NAME = "target-grid-v1"
HORIZON_PATTERN = re.compile(r"^(?P<count>[1-9]\d*)(?P<unit>d|h|min|m)$")
ANCHOR_PATTERN = re.compile(r"^(?P<hour>[01]\d|2[0-3]):(?P<minute>[0-5]\d)$")


@dataclass(frozen=True, slots=True)
class HorizonStep:
    target_timestamp: datetime
    horizon_step: int


@dataclass(frozen=True, slots=True)
class DateSplit:
    assignments: dict[date, SplitName]
    train_count: int
    validation_count: int
    test_count: int
    needs_input: bool = False
    needs_input_reason: str | None = None


@dataclass(frozen=True, slots=True)
class SamplePlanRow:
    sample_id: str
    split: SplitName
    local_day: date
    forecast_start_timestamp: datetime
    forecast_end_timestamp: datetime
    feature_cutoff_timestamp: datetime
    expected_horizon_steps: int
    segment_id: int | None
    eligible: bool
    exclusion_reason: str | None = None


@dataclass(frozen=True, slots=True)
class SamplePlanResult:
    rows: tuple[SamplePlanRow, ...]
    exclusion_reason_counts: dict[str, int]


def parse_forecast_horizon(value: str) -> int:
    """Return an integer count of minutes for a V1 horizon."""

    match = HORIZON_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("forecast_horizon must use an integer d, h, m, or min suffix")
    count = int(match.group("count"))
    unit = match.group("unit")
    if unit == "d":
        minutes = count * 1_440
    elif unit == "h":
        minutes = count * 60
    else:
        minutes = count
    if not 60 <= minutes <= 1_440:
        raise ValueError("forecast_horizon must be between 1h and 24h")
    return minutes


def parse_anchor_time(value: str) -> time:
    match = ANCHOR_PATTERN.fullmatch(value)
    if match is None:
        raise ValueError("anchor_time must use HH:MM at minute precision")
    return time(hour=int(match.group("hour")), minute=int(match.group("minute")))


def build_horizon(
    forecast_start_timestamp: datetime,
    horizon_minutes: int,
) -> tuple[HorizonStep, ...]:
    if forecast_start_timestamp.tzinfo is None:
        raise ValueError("forecast_start_timestamp must be timezone-aware")
    if not 60 <= horizon_minutes <= 1_440:
        raise ValueError("horizon must contain 60 through 1440 minute steps")
    return tuple(
        HorizonStep(
            target_timestamp=forecast_start_timestamp + offset * GRID_STEP,
            horizon_step=offset + 1,
        )
        for offset in range(horizon_minutes)
    )


def split_valid_days(days: Sequence[CalendarDay]) -> DateSplit:
    valid_days = sorted(day.local_day for day in days if day.valid)
    count = len(valid_days)
    train_count = floor(count * 0.7)
    validation_count = floor(count * 0.2)
    test_count = count - train_count - validation_count
    if min(train_count, validation_count, test_count) == 0:
        return DateSplit(
            assignments={},
            train_count=train_count,
            validation_count=validation_count,
            test_count=test_count,
            needs_input=True,
            needs_input_reason=(
                "valid days do not produce non-empty train, validation, and test sets"
            ),
        )

    assignments: dict[date, SplitName] = {}
    for index, local_day in enumerate(valid_days):
        if index < train_count:
            assignments[local_day] = "train"
        elif index < train_count + validation_count:
            assignments[local_day] = "validation"
        else:
            assignments[local_day] = "test"
    return DateSplit(
        assignments=assignments,
        train_count=train_count,
        validation_count=validation_count,
        test_count=test_count,
    )


def build_sample_plan(
    grid_rows: Sequence[TargetGridRow],
    valid_days: Sequence[CalendarDay],
    date_split: DateSplit,
    local_timezone: str,
    anchor_time: time,
    horizon_minutes: int,
) -> SamplePlanResult:
    timezone = ZoneInfo(local_timezone)
    grid_by_timestamp = {row.timestamp: row for row in grid_rows}
    rows: list[SamplePlanRow] = []
    exclusion_counts: Counter[str] = Counter()

    for day in sorted(
        (day for day in valid_days if day.valid),
        key=lambda item: item.local_day,
    ):
        split = date_split.assignments[day.local_day]
        local_start = datetime.combine(day.local_day, anchor_time, timezone)
        forecast_start = local_start.astimezone(UTC)
        horizon = build_horizon(forecast_start, horizon_minutes)
        forecast_end = horizon[-1].target_timestamp
        horizon_rows = [
            grid_by_timestamp.get(step.target_timestamp) for step in horizon
        ]
        reason = _sample_exclusion_reason(
            horizon_rows=horizon_rows,
            split=split,
            day_segment_id=day.segment_id,
            date_assignments=date_split.assignments,
            timezone=timezone,
        )
        if reason is not None:
            exclusion_counts[reason] += 1
        rows.append(
            SamplePlanRow(
                sample_id=(
                    f"{RULE_NAME}-{day.local_day:%Y%m%d}-"
                    f"{anchor_time:%H%M}-h{horizon_minutes:04d}"
                ),
                split=split,
                local_day=day.local_day,
                forecast_start_timestamp=forecast_start,
                forecast_end_timestamp=forecast_end,
                feature_cutoff_timestamp=forecast_start,
                expected_horizon_steps=horizon_minutes,
                segment_id=day.segment_id,
                eligible=reason is None,
                exclusion_reason=reason,
            )
        )
    return SamplePlanResult(
        rows=tuple(rows),
        exclusion_reason_counts=dict(sorted(exclusion_counts.items())),
    )


def run_skill2_sample_plan(
    bundle_path: str | Path,
    local_timezone: str,
    anchor_time: str,
    forecast_horizon: str,
) -> dict[str, object]:
    """Read one resolved target partition and return only a small JSON summary."""

    try:
        timezone = ZoneInfo(local_timezone)
        parsed_anchor = parse_anchor_time(anchor_time)
        horizon_minutes = parse_forecast_horizon(forecast_horizon)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        return _needs_input_summary(str(exc))

    reader = DatasetBundleReader(bundle_path)
    resolution = TargetResolver(reader).resolve()
    if resolution.needs_input:
        return _needs_input_summary(
            resolution.needs_input_reason or "target resolution needs input"
        )
    point_id = resolution.source_target_point_id
    source_partition = resolution.source_partition
    if point_id is None or source_partition is None:
        raise AssertionError("successful target resolution is incomplete")

    table = reader.read_point_timeseries(point_id, source_partition)
    _validate_target_table(table, point_id)
    grid = build_target_grid(
        table["timestamp"].to_pylist(),
        table["value_raw"].to_pylist(),
    )
    if grid.needs_input:
        return _summary(
            grid=grid,
            days=(),
            date_split=None,
            sample_plan=None,
            horizon_minutes=horizon_minutes,
            warnings=[grid.needs_input_reason or "target grid needs input"],
            needs_input=True,
        )

    days = summarize_calendar_days(grid.rows, timezone.key)
    date_split = split_valid_days(days)
    if date_split.needs_input:
        return _summary(
            grid=grid,
            days=days,
            date_split=date_split,
            sample_plan=None,
            horizon_minutes=horizon_minutes,
            warnings=[
                *grid.warnings,
                date_split.needs_input_reason or "date split needs input",
            ],
            needs_input=True,
        )
    sample_plan = build_sample_plan(
        grid.rows,
        days,
        date_split,
        timezone.key,
        parsed_anchor,
        horizon_minutes,
    )
    return _summary(
        grid=grid,
        days=days,
        date_split=date_split,
        sample_plan=sample_plan,
        horizon_minutes=horizon_minutes,
        warnings=list(grid.warnings),
        needs_input=False,
    )


def _sample_exclusion_reason(
    horizon_rows: Sequence[TargetGridRow | None],
    split: SplitName,
    day_segment_id: int | None,
    date_assignments: dict[date, SplitName],
    timezone: ZoneInfo,
) -> str | None:
    if any(row is None for row in horizon_rows):
        return "forecast_outside_target_grid"
    present_rows = [row for row in horizon_rows if row is not None]
    if any(
        row.gap_class == "long" or row.segment_id != day_segment_id
        for row in present_rows
    ):
        return "crosses_long_gap"
    if any(
        date_assignments.get(row.timestamp.astimezone(timezone).date()) != split
        for row in present_rows
    ):
        return "crosses_split_boundary"
    if split in ("train", "validation") and any(
        row.target_value is None for row in present_rows
    ):
        return "null_labels"
    return None


def _summary(
    grid: TargetGridResult,
    days: Sequence[CalendarDay],
    date_split: DateSplit | None,
    sample_plan: SamplePlanResult | None,
    horizon_minutes: int,
    warnings: list[str],
    needs_input: bool,
) -> dict[str, object]:
    gap_counts = grid.gap_counts or {}
    invalid_days = [day for day in days if not day.valid]
    planned_count = (
        sum(row.eligible for row in sample_plan.rows) if sample_plan else 0
    )
    excluded_count = (
        sum(not row.eligible for row in sample_plan.rows) if sample_plan else 0
    )
    return {
        "rule_name": RULE_NAME,
        "grid_rows": len(grid.rows),
        "observed_rows": sum(row.is_observed for row in grid.rows),
        "missing_rows": sum(not row.is_observed for row in grid.rows),
        "gap_counts": {
            gap_class: {
                "gap_count": summary.gap_count,
                "missing_minutes": summary.missing_minutes,
            }
            for gap_class, summary in gap_counts.items()
        },
        "segment_count": len(grid.segments),
        "segments": [
            {
                "segment_id": segment.segment_id,
                "start_timestamp": segment.start_timestamp.isoformat(),
                "end_timestamp": segment.end_timestamp.isoformat(),
                "observed_rows": segment.observed_rows,
            }
            for segment in grid.segments
        ],
        "total_calendar_days": len(days),
        "valid_day_count": sum(day.valid for day in days),
        "invalid_day_count": len(invalid_days),
        "invalid_days": [
            {
                "local_day": day.local_day.isoformat(),
                "exclusion_reasons": list(day.exclusion_reasons),
                "incomplete_minute_count": day.incomplete_minute_count,
                "segment_id": day.segment_id,
            }
            for day in invalid_days
        ],
        "train_day_count": date_split.train_count if date_split else 0,
        "validation_day_count": date_split.validation_count if date_split else 0,
        "test_day_count": date_split.test_count if date_split else 0,
        "planned_sample_count": planned_count,
        "excluded_sample_count": excluded_count,
        "exclusion_reason_counts": (
            sample_plan.exclusion_reason_counts if sample_plan else {}
        ),
        "horizon_steps": horizon_minutes,
        "warnings": warnings,
        "needs_input": needs_input,
    }


def _needs_input_summary(reason: str) -> dict[str, object]:
    return _summary(
        grid=TargetGridResult(gap_counts={}),
        days=(),
        date_split=None,
        sample_plan=None,
        horizon_minutes=0,
        warnings=[reason],
        needs_input=True,
    )
