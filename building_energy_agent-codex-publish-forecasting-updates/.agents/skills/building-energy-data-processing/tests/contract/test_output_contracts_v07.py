from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from building_energy_agent.contracts.fingerprints import (
    dataset_schema_fingerprint,
    feature_schema_fingerprint,
)
from building_energy_agent.contracts.skill1_v07 import (
    DatasetBundleManifest,
    PointCatalogEntry,
)
from building_energy_agent.contracts.skill2_v07 import (
    CategoricalMapping,
    FeatureCatalogEntry,
    ForecastIndexRow,
    ProcessingBundleManifest,
    TargetMetadata,
)


def valid_dataset_manifest_data() -> dict[str, object]:
    return {
        "bundle_type": "DatasetBundle",
        "bundle_version": "0.7",
        "dataset_bundle_id": "dataset-abc-rules-v1",
        "schema_fingerprint": "a" * 64,
        "time_start": "2026-01-01T00:00:00+00:00",
        "time_end": "2026-01-02T00:00:00+00:00",
    }


def test_dataset_manifest_top_level_is_strictly_closed() -> None:
    manifest = DatasetBundleManifest.model_validate(valid_dataset_manifest_data())
    assert set(manifest.model_dump()) == {
        "bundle_type",
        "bundle_version",
        "dataset_bundle_id",
        "schema_fingerprint",
        "time_start",
        "time_end",
    }

    with pytest.raises(ValidationError):
        DatasetBundleManifest.model_validate(
            {**valid_dataset_manifest_data(), "source_path": "/forbidden"}
        )


@pytest.mark.parametrize(
    "boundary",
    [datetime(2026, 1, 1), datetime(2026, 1, 1, tzinfo=timezone(timedelta(hours=8)))],
)
def test_dataset_manifest_requires_utc_boundaries(boundary: datetime) -> None:
    data = valid_dataset_manifest_data()
    data["time_start"] = boundary
    with pytest.raises(ValidationError):
        DatasetBundleManifest.model_validate(data)


def test_points_required_fields_and_variable_enum() -> None:
    point = PointCatalogEntry(
        point_id="BMS-001",
        name="冷机1",
        description="启停状态",
        unit=None,
        variable_type="state",
        expected_interval_seconds=60,
    )
    assert point.expected_interval_seconds > 0

    with pytest.raises(ValidationError):
        PointCatalogEntry(
            point_id="BMS-001",
            name="",
            description="",
            unit=None,
            variable_type="text",
            expected_interval_seconds=0,
        )


def test_dataset_schema_fingerprint_is_sorted_and_deterministic() -> None:
    points = [
        {
            "point_id": "b",
            "unit": None,
            "variable_type": "state",
            "expected_interval_seconds": 60,
            "ignored": "source-a",
        },
        {
            "point_id": "a",
            "unit": "kW",
            "variable_type": "continuous",
            "expected_interval_seconds": 300,
        },
    ]
    first = dataset_schema_fingerprint(points)
    second = dataset_schema_fingerprint(reversed(points))
    assert first == second
    assert len(first) == 64

    changed = [dict(point) for point in points]
    changed[0]["expected_interval_seconds"] = 120
    assert dataset_schema_fingerprint(changed) != first


def test_feature_schema_fingerprint_is_order_sensitive() -> None:
    entries = [
        {
            "feature_name": "lag_1",
            "data_type": "numeric",
            "source_point_id": "p1",
            "semantic_version": "v1",
        },
        {
            "feature_name": "is_weekend",
            "data_type": "boolean",
            "source_point_id": "",
            "semantic_version": "v1",
        },
    ]
    assert feature_schema_fingerprint(entries) != feature_schema_fingerprint(
        reversed(entries)
    )


def test_forecast_index_and_catalog_contracts() -> None:
    row = ForecastIndexRow(
        sample_id="sample-1",
        target_timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_step=1,
        horizon_duration="0min",
        calendar_hour=0,
        calendar_weekday=3,
        calendar_month=1,
    )
    assert set(ForecastIndexRow.model_fields) == {
        "sample_id",
        "target_timestamp",
        "horizon_step",
        "horizon_duration",
        "calendar_hour",
        "calendar_weekday",
        "calendar_month",
    }
    with pytest.raises(ValidationError):
        ForecastIndexRow(**{**row.model_dump(), "horizon_step": 0})

    entry = FeatureCatalogEntry(
        feature_name="lag_1",
        data_type="numeric",
        source_point_id="p1",
        semantic_version="v1",
    )
    assert entry.data_type == "numeric"


@pytest.mark.parametrize("duration", ["0min", "1min", "60min", "1440min"])
def test_horizon_duration_uses_canonical_minute_strings(duration: str) -> None:
    row = ForecastIndexRow(
        sample_id="sample-1",
        target_timestamp=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_step=1,
        horizon_duration=duration,
        calendar_hour=0,
        calendar_weekday=3,
        calendar_month=1,
    )
    assert row.horizon_duration == duration


@pytest.mark.parametrize(
    "duration",
    [0, 1.0, -1, "-1min", "1", "1m", "0s", "1.5min", "01min"],
)
def test_horizon_duration_rejects_ambiguous_values(duration: object) -> None:
    with pytest.raises(ValidationError):
        ForecastIndexRow(
            sample_id="sample-1",
            target_timestamp=datetime(2026, 1, 1, tzinfo=UTC),
            horizon_step=1,
            horizon_duration=duration,
            calendar_hour=0,
            calendar_weekday=3,
            calendar_month=1,
        )


def test_target_metadata_supports_resolved_load_targets() -> None:
    target = TargetMetadata(
        target_point_id="总冷机冷负荷",
        target_name="总冷机冷负荷",
        target_unit="kW",
        source_target_point_id="BMS-real-id",
    )
    assert set(target.model_dump()) == {
        "target_point_id",
        "target_name",
        "target_unit",
        "source_target_point_id",
    }
    other = TargetMetadata(
        target_point_id="总冷机电负荷",
        target_name="总冷机电负荷",
        target_unit="kW",
        source_target_point_id="BMS-electric-id",
    )
    assert other.target_name == "总冷机电负荷"
    assert CategoricalMapping(unknown=-1, values=[-1, 0, 1]).unknown == -1
    with pytest.raises(ValidationError):
        CategoricalMapping(unknown=-1, values=[0, 1])


def test_processing_manifest_requires_passed_and_non_empty_hashes() -> None:
    manifest = ProcessingBundleManifest(
        processing_bundle_id="processing-1",
        source_bundle_id="dataset-1",
        leakage_check_status="passed",
        leakage_check_rule_version="leakage-v1",
        processing_rule_version="processing-v0.7",
        data_granularity="1min",
        feature_schema_fingerprint="b" * 64,
        file_hashes={"feature_catalog.parquet": "c" * 64},
        processing_trace={"preset": "future-compatible"},
    )
    assert manifest.leakage_check_status == "passed"
    assert manifest.model_extra == {"processing_trace": {"preset": "future-compatible"}}
    with pytest.raises(ValidationError):
        ProcessingBundleManifest.model_validate(
            {**manifest.model_dump(), "file_hashes": {}}
        )


@pytest.mark.parametrize("bundle_id", ["bundle-1", "A.b_c-2", "dataset"])
def test_bundle_ids_are_safe_opaque_segments(bundle_id: str) -> None:
    dataset_data = valid_dataset_manifest_data()
    dataset_data["dataset_bundle_id"] = bundle_id
    dataset = DatasetBundleManifest.model_validate(dataset_data)
    assert dataset.dataset_bundle_id == bundle_id

    processing = ProcessingBundleManifest(
        processing_bundle_id=bundle_id,
        source_bundle_id=bundle_id,
        leakage_check_rule_version="leakage-v1",
        processing_rule_version="processing-v0.7",
        data_granularity="1min",
        feature_schema_fingerprint="b" * 64,
        file_hashes={"features/split=train/data.parquet": "c" * 64},
    )
    assert processing.processing_bundle_id == bundle_id


@pytest.mark.parametrize(
    "bundle_id",
    ["", ".", "..", "../bundle", "a/b", r"a\b", "/absolute"],
)
def test_bundle_ids_reject_path_syntax(bundle_id: str) -> None:
    dataset_data = valid_dataset_manifest_data()
    dataset_data["dataset_bundle_id"] = bundle_id
    with pytest.raises(ValidationError):
        DatasetBundleManifest.model_validate(dataset_data)

    with pytest.raises(ValidationError):
        ProcessingBundleManifest(
            processing_bundle_id=bundle_id,
            source_bundle_id="dataset-1",
            leakage_check_rule_version="leakage-v1",
            processing_rule_version="processing-v0.7",
            data_granularity="1min",
            feature_schema_fingerprint="b" * 64,
            file_hashes={"feature_catalog.parquet": "c" * 64},
        )


@pytest.mark.parametrize(
    "relative_path",
    [
        "feature_catalog.parquet",
        "features/split=train/data.parquet",
        "forecast_index/split=future/data.parquet",
    ],
)
def test_file_hashes_accept_safe_bundle_relative_paths(relative_path: str) -> None:
    manifest = ProcessingBundleManifest(
        processing_bundle_id="processing-1",
        source_bundle_id="dataset-1",
        leakage_check_rule_version="leakage-v1",
        processing_rule_version="processing-v0.7",
        data_granularity="1min",
        feature_schema_fingerprint="b" * 64,
        file_hashes={relative_path: "c" * 64},
    )
    assert relative_path in manifest.file_hashes


@pytest.mark.parametrize(
    "relative_path",
    [
        "",
        ".",
        "../outside.parquet",
        "features/../outside.parquet",
        "/absolute.parquet",
        r"features\split=train\data.parquet",
        "./feature_catalog.parquet",
        "features//data.parquet",
    ],
)
def test_file_hashes_reject_unsafe_paths(relative_path: str) -> None:
    with pytest.raises(ValidationError):
        ProcessingBundleManifest(
            processing_bundle_id="processing-1",
            source_bundle_id="dataset-1",
            leakage_check_rule_version="leakage-v1",
            processing_rule_version="processing-v0.7",
            data_granularity="1min",
            feature_schema_fingerprint="b" * 64,
            file_hashes={relative_path: "c" * 64},
        )


@pytest.mark.parametrize("digest", ["g" * 64, "-" + "c" * 63, "c" * 63])
def test_file_hashes_reject_non_sha256_digests(digest: str) -> None:
    with pytest.raises(ValidationError):
        ProcessingBundleManifest(
            processing_bundle_id="processing-1",
            source_bundle_id="dataset-1",
            leakage_check_rule_version="leakage-v1",
            processing_rule_version="processing-v0.7",
            data_granularity="1min",
            feature_schema_fingerprint="b" * 64,
            file_hashes={"feature_catalog.parquet": digest},
        )
