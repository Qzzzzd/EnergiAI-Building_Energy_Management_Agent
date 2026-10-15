"""Internal one-minute target grid and local-day qualification rules."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal, Sequence
from zoneinfo import ZoneInfo

TargetValue = int | float | Decimal | None
GapClass = Literal["none", "short", "medium", "long"]
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


def build_target_grid(
    timestamps: Sequence[datetime],
    target_values: Sequence[TargetValue],
) -> TargetGridResult:
    """Build an inclusive one-minute UTC grid without target interpolation."""

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
        missing_minutes = int(
            (timestamp - previous_timestamp).total_seconds() // 60
        ) - 1
        gap_class = classify_gap(missing_minutes)
        mutable_gaps[gap_class][0] += 1
        mutable_gaps[gap_class][1] += missing_minutes

        missing_segment = None if gap_class == "long" else segment_id
        for minute_offset in range(1, missing_minutes + 1):
            rows.append(
                TargetGridRow(
                    previous_timestamp + minute_offset * GRID_STEP,
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


def summarize_calendar_days(
    rows: Sequence[TargetGridRow],
    local_timezone: str,
) -> tuple[CalendarDay, ...]:
    """Classify local days while retaining all minute-grid rows."""

    timezone = ZoneInfo(local_timezone)
    grouped: dict[date, list[TargetGridRow]] = defaultdict(list)
    for row in rows:
        grouped[row.timestamp.astimezone(timezone).date()].append(row)

    days: list[CalendarDay] = []
    for local_day, day_rows in sorted(grouped.items()):
        non_null_count = sum(row.target_value is not None for row in day_rows)
        incomplete_count = max(0, MINUTES_PER_DAY - non_null_count)
        segment_ids = {
            row.segment_id for row in day_rows if row.segment_id is not None
        }
        reasons: list[str] = []
        if len(day_rows) != MINUTES_PER_DAY:
            reasons.append("incomplete_calendar_day")
        if non_null_count != MINUTES_PER_DAY:
            reasons.append("null_target_value")
        if any(row.gap_class == "long" for row in day_rows):
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
            )
        )
    return tuple(days)


def _empty_gap_counts() -> dict[GapClass, GapSummary]:
    return {
        gap_class: GapSummary()
        for gap_class in ("none", "short", "medium", "long")
    }
