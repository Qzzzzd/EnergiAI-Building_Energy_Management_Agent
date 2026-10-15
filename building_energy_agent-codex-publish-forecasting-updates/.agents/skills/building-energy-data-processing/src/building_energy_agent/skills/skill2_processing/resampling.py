"""Internal one-minute target grid and local-day qualification rules."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Literal, Sequence
from zoneinfo import ZoneInfo

TargetValue = int | float | Decimal | None
GapClass = Literal["none", "short", "medium", "long"]
OperatingWindow = tuple[time, time]
GRID_STEP = timedelta(minutes=1)
MINUTES_PER_DAY = 1_440


@dataclass(frozen=True, slots=True)
class TargetGridRow:
    timestamp: datetime
    target_value: TargetValue
    is_observed: bool
    gap_class: GapClass
    segment_id: int | None


@dataclass(frozen=True, slots=True)
class GapSummary:
    gap_count: int = 0
    missing_minutes: int = 0


@dataclass(frozen=True, slots=True)
class SegmentSummary:
    segment_id: int
    start_timestamp: datetime
    end_timestamp: datetime
    observed_rows: int


@dataclass(frozen=True, slots=True)
class TargetGridResult:
    rows: tuple[TargetGridRow, ...] = ()
    gap_counts: dict[GapClass, GapSummary] | None = None
    segments: tuple[SegmentSummary, ...] = ()
    warnings: tuple[str, ...] = ()
    needs_input: bool = False
    needs_input_reason: str | None = None


@dataclass(frozen=True, slots=True)
class CalendarDay:
    local_day: date
    valid: bool
    exclusion_reasons: tuple[str, ...]
    incomplete_minute_count: int
    segment_id: int | None
    operating_window: OperatingWindow | None = None


def build_target_grid(
    timestamps: Sequence[datetime],
    target_values: Sequence[TargetValue],
    grid_step: timedelta = GRID_STEP,
) -> TargetGridResult:
    """Build an inclusive source-granularity UTC grid without interpolation."""

    if grid_step.total_seconds() <= 0 or grid_step.total_seconds() % 60:
        raise ValueError("grid_step must be a positive whole-minute interval")

    empty_gaps = _empty_gap_counts()
    if len(timestamps) != len(target_values):
        raise ValueError("timestamps and target_values must have equal length")
    if not timestamps:
        return TargetGridResult(
            gap_counts=empty_gaps,
            needs_input=True,
            needs_input_reason="target contains no observations",
        )

    invalid_timestamp = next(
        (
            timestamp
            for timestamp in timestamps
            if timestamp.tzinfo is None
            or timestamp.utcoffset() != UTC.utcoffset(timestamp)
            or timestamp.second != 0
            or timestamp.microsecond != 0
        ),
        None,
    )
    if invalid_timestamp is not None:
        return TargetGridResult(
            gap_counts=empty_gaps,
            needs_input=True,
            needs_input_reason=(
                "target timestamps must be UTC and aligned to whole minutes"
            ),
        )
    if len(set(timestamps)) != len(timestamps):
        return TargetGridResult(
            gap_counts=empty_gaps,
            needs_input=True,
            needs_input_reason="target contains duplicate timestamps",
        )

    observations = sorted(zip(timestamps, target_values, strict=True))
    mutable_gaps: dict[GapClass, list[int]] = {
        gap_class: [0, 0] for gap_class in ("none", "short", "medium", "long")
    }
    rows: list[TargetGridRow] = []
    segment_id = 1
    first_timestamp, first_value = observations[0]
    rows.append(
        TargetGridRow(first_timestamp, first_value, True, "none", segment_id)
    )

    for (previous_timestamp, _), (timestamp, value) in zip(
        observations, observations[1:], strict=False
    ):
        interval_steps = int(
            (timestamp - previous_timestamp).total_seconds()
            // grid_step.total_seconds()
        )
        missing_steps = max(0, interval_steps - 1)
        missing_minutes = int(missing_steps * grid_step.total_seconds() // 60)
        gap_class = classify_gap(missing_minutes)
        mutable_gaps[gap_class][0] += 1
        mutable_gaps[gap_class][1] += missing_minutes

        missing_segment = None if gap_class == "long" else segment_id
        for step_offset in range(1, missing_steps + 1):
            rows.append(
                TargetGridRow(
                    previous_timestamp + step_offset * grid_step,
                    None,
                    False,
                    gap_class,
                    missing_segment,
                )
            )
        if gap_class == "long":
            segment_id += 1
        rows.append(TargetGridRow(timestamp, value, True, "none", segment_id))

    gap_counts = {
        gap_class: GapSummary(
            gap_count=counts[0],
            missing_minutes=counts[1],
        )
        for gap_class, counts in mutable_gaps.items()
    }
    missing_rows = sum(not row.is_observed for row in rows)
    warnings: list[str] = []
    if missing_rows:
        warnings.append(
            f"target grid contains {missing_rows} missing minute(s); "
            "target values were not interpolated"
        )
    if gap_counts["long"].gap_count:
        warnings.append(
            f"{gap_counts['long'].gap_count} long gap(s) split the target into "
            f"{segment_id} segments"
        )
    return TargetGridResult(
        rows=tuple(rows),
        gap_counts=gap_counts,
        segments=summarize_segments(rows),
        warnings=tuple(warnings),
    )


def classify_gap(missing_minutes: int) -> GapClass:
    if missing_minutes < 0:
        raise ValueError("observations must have increasing timestamps")
    if missing_minutes == 0:
        return "none"
    if missing_minutes <= 15:
        return "short"
    if missing_minutes < 360:
        return "medium"
    return "long"


def summarize_segments(
    rows: Sequence[TargetGridRow],
) -> tuple[SegmentSummary, ...]:
    grouped: dict[int, list[TargetGridRow]] = defaultdict(list)
    for row in rows:
        if row.is_observed and row.segment_id is not None:
            grouped[row.segment_id].append(row)
    return tuple(
        SegmentSummary(
            segment_id=segment_id,
            start_timestamp=segment_rows[0].timestamp,
            end_timestamp=segment_rows[-1].timestamp,
            observed_rows=len(segment_rows),
        )
        for segment_id, segment_rows in sorted(grouped.items())
    )


def infer_operating_window(
    rows: Sequence[TargetGridRow],
    local_timezone: str,
    row_interval_minutes: int = 1,
) -> OperatingWindow | None:
    """Infer a repeated intra-day window from contiguous observed segments."""

    if row_interval_minutes <= 0:
        raise ValueError("row_interval_minutes must be positive")

    timezone = ZoneInfo(local_timezone)
    observed_by_day: dict[date, list[TargetGridRow]] = defaultdict(list)
    for row in rows:
        if not row.is_observed or row.target_value is None or row.segment_id is None:
            continue
        observed_by_day[row.timestamp.astimezone(timezone).date()].append(row)

    candidates: Counter[tuple[int, int, int]] = Counter()
    interval_seconds = row_interval_minutes * 60
    for day_rows in observed_by_day.values():
        ordered = sorted(day_rows, key=lambda row: row.timestamp)
        if len({row.segment_id for row in ordered}) != 1:
            continue
        if any(
            (current.timestamp - previous.timestamp).total_seconds()
            != interval_seconds
            for previous, current in zip(ordered, ordered[1:], strict=False)
        ):
            continue
        local_start = ordered[0].timestamp.astimezone(timezone)
        local_end = ordered[-1].timestamp.astimezone(timezone) + timedelta(
            minutes=row_interval_minutes
        )
        if local_end.date() != local_start.date():
            continue
        start_minute = local_start.hour * 60 + local_start.minute
        end_minute = local_end.hour * 60 + local_end.minute
        if end_minute <= start_minute:
            continue
        candidates[(start_minute, end_minute, len(ordered))] += 1

    if not candidates:
        return None
    (start_minute, end_minute, row_count), occurrences = candidates.most_common(1)[0]
    if occurrences < 2 or row_count != (end_minute - start_minute) // row_interval_minutes:
        return None
    return (
        time(hour=start_minute // 60, minute=start_minute % 60),
        time(hour=end_minute // 60, minute=end_minute % 60),
    )


def summarize_calendar_days(
    rows: Sequence[TargetGridRow],
    local_timezone: str,
    rows_per_day: int = MINUTES_PER_DAY,
    row_interval_minutes: int = 1,
    operating_window: OperatingWindow | None = None,
) -> tuple[CalendarDay, ...]:
    """Classify local days while retaining all source-granularity rows."""

    if rows_per_day <= 0:
        raise ValueError("rows_per_day must be positive")
    if row_interval_minutes <= 0:
        raise ValueError("row_interval_minutes must be positive")

    timezone = ZoneInfo(local_timezone)
    grouped: dict[date, list[TargetGridRow]] = defaultdict(list)
    for row in rows:
        grouped[row.timestamp.astimezone(timezone).date()].append(row)

    days: list[CalendarDay] = []
    for local_day, day_rows in sorted(grouped.items()):
        scoped_rows = day_rows
        expected_rows = rows_per_day
        if operating_window is not None:
            start_minute = operating_window[0].hour * 60 + operating_window[0].minute
            end_minute = operating_window[1].hour * 60 + operating_window[1].minute
            expected_rows = (end_minute - start_minute) // row_interval_minutes
            scoped_rows = [
                row
                for row in day_rows
                if start_minute
                <= (
                    row.timestamp.astimezone(timezone).hour * 60
                    + row.timestamp.astimezone(timezone).minute
                )
                < end_minute
            ]
        non_null_count = sum(row.target_value is not None for row in scoped_rows)
        incomplete_count = (
            max(0, expected_rows - non_null_count) * row_interval_minutes
        )
        segment_ids = {
            row.segment_id for row in scoped_rows if row.segment_id is not None
        }
        reasons: list[str] = []
        if len(scoped_rows) != expected_rows:
            reasons.append("incomplete_calendar_day")
        if non_null_count != expected_rows:
            reasons.append("null_target_value")
        if any(row.gap_class == "long" for row in scoped_rows):
            reasons.append("long_gap")
        if len(segment_ids) != 1:
            reasons.append("multiple_or_missing_segments")
        days.append(
            CalendarDay(
                local_day=local_day,
                valid=not reasons,
                exclusion_reasons=tuple(reasons),
                incomplete_minute_count=incomplete_count,
                segment_id=next(iter(segment_ids)) if len(segment_ids) == 1 else None,
                operating_window=operating_window,
            )
        )
    return tuple(days)


def _empty_gap_counts() -> dict[GapClass, GapSummary]:
    return {
        gap_class: GapSummary()
        for gap_class in ("none", "short", "medium", "long")
    }
