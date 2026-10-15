from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from building_energy_agent.contracts.skill1_v07 import (
    ParseRequest,
    Skill1ResultResponse,
    SourceReference,
    TimeseriesRecord,
)


def test_parse_request_supports_multiple_sources() -> None:
    request = ParseRequest(
        sources=[
            SourceReference(source_ref="source-a"),
            SourceReference(source_ref="source-b"),
        ],
        parse_hints={"timestamp_column": "observed_at"},
    )

    assert [item.source_ref for item in request.sources] == [
        "source-a",
        "source-b",
    ]
    assert request.parse_hints == {"timestamp_column": "observed_at"}


def test_parse_request_sources_cannot_be_empty() -> None:
    with pytest.raises(ValidationError):
        ParseRequest(sources=[])


def test_source_ref_is_required() -> None:
    with pytest.raises(ValidationError):
        SourceReference()


def test_strict_mode_defaults_to_false() -> None:
    request = ParseRequest(sources=[SourceReference(source_ref="source-a")])

    assert request.strict_mode is False


def test_parse_hints_do_not_change_source_structure() -> None:
    request = ParseRequest(
        sources=[{"source_ref": "source-a"}],
        parse_hints={"arbitrary_future_hint": {"enabled": True}},
    )

    assert request.sources == [SourceReference(source_ref="source-a")]
    assert request.parse_hints["arbitrary_future_hint"] == {"enabled": True}


def test_skill1_schema_excludes_processing_configuration() -> None:
    fields = set(ParseRequest.model_fields)

    assert "missing_values" not in fields
    assert "outliers" not in fields
    assert "feature_spec" not in fields
    assert "cleaning" not in fields

    with pytest.raises(ValidationError):
        ParseRequest(
            sources=[{"source_ref": "source-a"}],
            missing_values={"policy": "invented"},
        )


def test_timeseries_minimum_schema_requires_numeric_raw_values() -> None:
    row = TimeseriesRecord(
        timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        point_id="opaque-point-id",
        value_raw=1,
    )

    assert row.value_raw == 1

    with pytest.raises(ValidationError):
        TimeseriesRecord(timestamp=row.timestamp, point_id=row.point_id, value_raw="ON")


@pytest.mark.parametrize("bundle_id", ["../bundle", "a/b", r"a\b", ".", ".."])
def test_skill1_result_rejects_path_like_bundle_ids(bundle_id: str) -> None:
    with pytest.raises(ValidationError):
        Skill1ResultResponse(dataset_bundle_id=bundle_id, summary={})
