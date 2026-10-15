from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta

import pytest

from building_energy_agent.skills.skill2_processing.resampling import (
    CalendarDay,
    build_target_grid,
    summarize_calendar_days,
)
from building_energy_agent.skills.skill2_processing.samples import (
    DateSplit,
    build_horizon,
    build_sample_plan,
    parse_forecast_horizon,
    split_valid_days,
)
from building_energy_agent.skills.skill2_processing.pipeline import (
    ExogenousHistory,
    _exogenous_features,
    _v2_target_features,
)


def test_minute_grid_includes_both_observed_boundaries() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    result = build_target_grid(
        [start, start + timedelta(minutes=2)],
        [1.0, 3.0],
    )

    assert [row.timestamp for row in result.rows] == [
        start,
        start + timedelta(minutes=1),
        start + timedelta(minutes=2),
    ]
    assert result.rows[0].target_value == 1.0
    assert result.rows[-1].target_value == 3.0


def test_fifteen_minute_grid_preserves_source_granularity() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    result = build_target_grid(
        [start, start + timedelta(minutes=30)],
        [1.0, 3.0],
        timedelta(minutes=15),
    )

    assert [row.timestamp for row in result.rows] == [
        start,
        start + timedelta(minutes=15),
        start + timedelta(minutes=30),
    ]
    assert result.rows[1].target_value is None
    assert result.gap_counts["short"].missing_minutes == 15


def test_fifteen_minute_horizon_has_ninety_six_steps() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    horizon = build_horizon(start, 1_440, timedelta(minutes=15))

    assert len(horizon) == 96
    assert horizon[-1].target_timestamp == start + timedelta(minutes=1_425)


def test_twelve_minute_short_gap_stays_null_without_segment_break() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    result = build_target_grid(
        [start, start + timedelta(minutes=13)],
        [1.0, 2.0],
    )
    missing = [row for row in result.rows if not row.is_observed]

    assert len(missing) == 12
    assert all(row.target_value is None for row in missing)
    assert all(row.gap_class == "short" for row in missing)
    assert {row.segment_id for row in result.rows} == {1}
    assert result.gap_counts is not None
    assert result.gap_counts["short"].missing_minutes == 12


def test_long_gap_starts_a_new_segment() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    result = build_target_grid(
        [start, start + timedelta(minutes=361)],
        [1.0, 2.0],
    )

    assert result.rows[0].segment_id == 1
    assert result.rows[-1].segment_id == 2
    assert all(row.segment_id is None for row in result.rows[1:-1])
    assert len(result.segments) == 2


def test_any_null_target_makes_local_calendar_day_invalid() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    timestamps = [
        start + offset * timedelta(minutes=1) for offset in range(1_440)
    ]
    values = [1.0] * 1_440
    values[100] = None

    days = summarize_calendar_days(
        build_target_grid(timestamps, values).rows,
        "UTC",
    )

    assert len(days) == 1
    assert days[0].valid is False
    assert days[0].incomplete_minute_count == 1
    assert "null_target_value" in days[0].exclusion_reasons


def test_valid_days_split_in_order_as_seven_two_one() -> None:
    days = [
        CalendarDay(
            local_day=date(2026, 1, day),
            valid=True,
            exclusion_reasons=(),
            incomplete_minute_count=0,
            segment_id=1,
        )
        for day in range(1, 11)
    ]

    result = split_valid_days(days)

    assert (result.train_count, result.validation_count, result.test_count) == (
        7,
        2,
        1,
    )
    assert list(result.assignments.values()) == [
        *(["train"] * 7),
        *(["validation"] * 2),
        "test",
    ]


def test_twenty_valid_days_split_only_on_complete_day_boundaries() -> None:
    days = [
        CalendarDay(
            local_day=date(2026, 1, 1) + timedelta(days=offset),
            valid=True,
            exclusion_reasons=(),
            incomplete_minute_count=0,
            segment_id=1,
        )
        for offset in range(20)
    ]

    result = split_valid_days(days)

    assert (result.train_count, result.validation_count, result.test_count) == (
        14,
        4,
        2,
    )
    assert result.assignments[date(2026, 1, 14)] == "train"
    assert result.assignments[date(2026, 1, 15)] == "validation"
    assert result.assignments[date(2026, 1, 19)] == "test"


def test_six_hour_horizon_has_steps_one_through_360() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)

    horizon = build_horizon(start, 360)

    assert len(horizon) == 360
    assert [horizon[0].horizon_step, horizon[-1].horizon_step] == [1, 360]
    assert horizon[-1].target_timestamp == start + timedelta(minutes=359)


def test_one_day_forecast_horizon_equals_twenty_four_hours() -> None:
    assert parse_forecast_horizon("1d") == parse_forecast_horizon("24h") == 1_440


def test_user_selected_horizon_is_not_capped_at_one_day() -> None:
    assert parse_forecast_horizon("7d") == 10_080


def test_horizon_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive duration"):
        parse_forecast_horizon("0h")


def test_long_horizon_reuses_previous_day_profile_without_future_values() -> None:
    history = [float(value) for value in range(1_440)]

    features = _v2_target_features(history, granularity_minutes=1, horizon_steps=1_441)

    assert features["target_profile_lag_1440min_step_1"] == 1_439.0
    assert features["target_profile_lag_1440min_step_1440"] == 0.0
    assert features["target_profile_lag_1440min_step_1441"] == 1_439.0


def test_sample_plan_excludes_forecast_crossing_long_gap() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    first_day = [
        start + offset * timedelta(minutes=1) for offset in range(1_440)
    ]
    timestamps = [*first_day, start + timedelta(days=1, hours=6)]
    grid = build_target_grid(timestamps, [1.0] * len(timestamps))
    days = summarize_calendar_days(grid.rows, "UTC")
    valid_day = next(day for day in days if day.valid)
    date_split = DateSplit(
        assignments={valid_day.local_day: "train"},
        train_count=1,
        validation_count=0,
        test_count=0,
    )

    plan = build_sample_plan(
        grid.rows,
        [valid_day],
        date_split,
        "UTC",
        time(23, 0),
        120,
    )

    assert plan.rows[0].eligible is False
    assert plan.rows[0].exclusion_reason == "crosses_long_gap"


def test_hourly_origins_keep_twenty_four_hour_horizon_inside_each_day_split() -> None:
    start = datetime(2026, 1, 1, tzinfo=UTC)
    timestamps = [
        start + offset * timedelta(minutes=1) for offset in range(4 * 1_440)
    ]
    grid = build_target_grid(timestamps, [1.0] * len(timestamps))
    days = summarize_calendar_days(grid.rows, "UTC")
    date_split = DateSplit(
        assignments={
            date(2026, 1, 1): "train",
            date(2026, 1, 2): "train",
            date(2026, 1, 3): "validation",
            date(2026, 1, 4): "validation",
        },
        train_count=2,
        validation_count=2,
        test_count=0,
    )

    plan = build_sample_plan(
        grid.rows,
        days,
        date_split,
        "UTC",
        time(0, 0),
        1_440,
        origin_interval_minutes=60,
    )

    eligible = [row for row in plan.rows if row.eligible]
    assert len(plan.rows) == 4 * 24
    assert len(eligible) == 50
    assert eligible[0].forecast_start_timestamp == datetime(2026, 1, 1, tzinfo=UTC)
    assert eligible[24].forecast_start_timestamp == datetime(2026, 1, 2, tzinfo=UTC)
    assert eligible[25].forecast_start_timestamp == datetime(2026, 1, 3, tzinfo=UTC)
    assert plan.exclusion_reason_counts == {
        "crosses_split_boundary": 23,
        "forecast_outside_target_grid": 23,
    }


def test_exogenous_features_ignore_values_at_or_after_forecast_cutoff() -> None:
    cutoff = datetime(2026, 1, 2, tzinfo=UTC)
    timestamps = tuple(
        cutoff + timedelta(minutes=offset) for offset in (-60, -1, 0, 1)
    )
    base = ExogenousHistory(
        feature_prefix="exog_01",
        point_id="IT-POWER",
        display_name="IT power",
        variable_type="continuous",
        timestamps=timestamps,
        values=(10.0, 20.0, 30.0, 40.0),
    )
    mutated_future = ExogenousHistory(
        feature_prefix=base.feature_prefix,
        point_id=base.point_id,
        display_name=base.display_name,
        variable_type=base.variable_type,
        timestamps=timestamps,
        values=(10.0, 20.0, 30_000.0, 40_000.0),
    )

    assert _exogenous_features((base,), cutoff) == _exogenous_features(
        (mutated_future,),
        cutoff,
    )


@pytest.mark.parametrize(
    ("timestamps", "reason"),
    [
        (
            [
                datetime(2026, 1, 1, tzinfo=UTC),
                datetime(2026, 1, 1, tzinfo=UTC),
            ],
            "duplicate",
        ),
        (
            [datetime(2026, 1, 1, 0, 0, 1, tzinfo=UTC)],
            "whole minutes",
        ),
    ],
)
def test_ambiguous_timestamps_return_needs_input(
    timestamps: list[datetime],
    reason: str,
) -> None:
    result = build_target_grid(timestamps, [1.0] * len(timestamps))

    assert result.needs_input is True
    assert reason in (result.needs_input_reason or "")
