from __future__ import annotations

import sys
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from building_energy_agent.contracts.bundle_layouts import (
    PROCESSING_BACKTEST_BUNDLE_V07,
    PROCESSING_FUTURE_BUNDLE_V07,
)
from building_energy_agent.contracts.skill2_v07 import (
    FeatureCatalogEntry,
    FeatureSetRow,
    ForecastIndexRow,
    LabelSetRow,
    TargetMetadata,
)
from building_energy_agent.skills.skill2_processing.artifacts import (
    LocalProcessingBundleStore,
)
from building_energy_agent.skills.skill2_processing.bundle_writer import (
    LocalProcessingBundleWriter,
    ProcessingBundleWriteRequest,
)


SKILLS_ROOT = Path(__file__).resolve().parents[3]
SKILL4_SCRIPTS = SKILLS_ROOT / "building-energy-load-forecasting" / "scripts"
sys.path.insert(0, str(SKILL4_SCRIPTS))

from load_forecasting.bundle import (  # noqa: E402
    load_processing_bundle,
    validate_and_expand,
)


CATALOG = (
    FeatureCatalogEntry(
        feature_name="load_lag_1",
        data_type="numeric",
        source_point_id="BMS-TARGET",
        semantic_version="lag-v1",
    ),
)
TARGET = TargetMetadata(source_target_point_id="BMS-TARGET")


def _feature(sample_id: str, start: datetime, value: float) -> FeatureSetRow:
    return FeatureSetRow(
        sample_id=sample_id,
        feature_cutoff_timestamp=start,
        forecast_start_timestamp=start,
        forecast_end_timestamp=start + timedelta(minutes=1),
        load_lag_1=value,
    )


def _forecast_index(
    sample_id: str,
    start: datetime,
) -> tuple[ForecastIndexRow, ForecastIndexRow]:
    return tuple(
        ForecastIndexRow(
            sample_id=sample_id,
            target_timestamp=start + timedelta(minutes=minute),
            horizon_step=minute + 1,
            horizon_duration=f"{minute}min",
            calendar_hour=(start + timedelta(minutes=minute)).hour,
            calendar_weekday=(start + timedelta(minutes=minute)).weekday(),
            calendar_month=(start + timedelta(minutes=minute)).month,
        )
        for minute in range(2)
    )


def _labels(
    sample_id: str,
    start: datetime,
    base_value: float,
) -> tuple[LabelSetRow, LabelSetRow]:
    return tuple(
        LabelSetRow(
            sample_id=sample_id,
            target_timestamp=start + timedelta(minutes=minute),
            target_value=base_value + minute,
        )
        for minute in range(2)
    )


def _backtest_request() -> ProcessingBundleWriteRequest:
    starts = {
        "train": datetime(2026, 1, 1, tzinfo=UTC),
        "validation": datetime(2026, 1, 2, tzinfo=UTC),
        "test": datetime(2026, 1, 3, tzinfo=UTC),
    }
    return ProcessingBundleWriteRequest(
        mode="backtest",
        source_bundle_id="dataset-synthetic",
        feature_catalog=CATALOG,
        target_metadata=TARGET,
        categorical_mappings={},
        features={
            split: (_feature(f"{split}-001", start, 10.0 + index),)
            for index, (split, start) in enumerate(starts.items())
        },
        forecast_index={
            split: _forecast_index(f"{split}-001", start)
            for split, start in starts.items()
        },
        labels={
            split: _labels(f"{split}-001", start, 20.0 + index)
            for index, (split, start) in enumerate(starts.items())
        },
        split_manifest={
            "mode": "backtest",
            "splits": {
                split: {"sample_count": 1} for split in starts
            },
        },
        processing_report={
            "status": "succeeded",
            "warnings": [],
            "algorithm_execution": "synthetic-contract-fixture-only",
        },
    )


def _future_request() -> ProcessingBundleWriteRequest:
    start = datetime(2026, 2, 1, tzinfo=UTC)
    return ProcessingBundleWriteRequest(
        mode="future",
        source_bundle_id="dataset-synthetic",
        feature_catalog=CATALOG,
        target_metadata=TARGET,
        categorical_mappings={},
        features={"future": (_feature("future-001", start, 15.0),)},
        forecast_index={"future": _forecast_index("future-001", start)},
        split_manifest={
            "mode": "future",
            "splits": {"future": {"sample_count": 1}},
        },
        processing_report={
            "status": "succeeded",
            "warnings": [],
            "algorithm_execution": "synthetic-contract-fixture-only",
        },
    )


@pytest.mark.integration
def test_skill4_loads_and_expands_skill2_backtest_bundle(tmp_path: Path) -> None:
    writer = LocalProcessingBundleWriter(tmp_path)
    outcome = writer.write(_backtest_request())

    PROCESSING_BACKTEST_BUNDLE_V07.validate(outcome.bundle_path)
    bundle = load_processing_bundle(
        tmp_path,
        outcome.processing_bundle_id,
        "backtest",
    )
    expanded, model_features, categorical = validate_and_expand(
        bundle,
        "train",
        True,
    )

    assert len(expanded) == 2
    assert expanded["target_value"].tolist() == [20.0, 21.0]
    assert model_features == [
        "load_lag_1",
        "calendar_hour",
        "calendar_weekday",
        "calendar_month",
        "horizon_step",
    ]
    assert categorical == []
    assert bundle.manifest["source_bundle_id"] == "dataset-synthetic"
    assert bundle.manifest["processing_mode"] == "backtest"
    assert writer.write(_backtest_request()).processing_bundle_id == (
        outcome.processing_bundle_id
    )

    manifest_ref = LocalProcessingBundleStore(tmp_path).manifest_ref(
        outcome.processing_bundle_id
    )
    assert Path(manifest_ref.location_ref) == outcome.bundle_path / "manifest.json"


@pytest.mark.integration
def test_skill4_loads_and_expands_skill2_future_bundle(tmp_path: Path) -> None:
    outcome = LocalProcessingBundleWriter(tmp_path).write(_future_request())

    PROCESSING_FUTURE_BUNDLE_V07.validate(outcome.bundle_path)
    bundle = load_processing_bundle(
        tmp_path,
        outcome.processing_bundle_id,
        "future",
    )
    expanded, model_features, categorical = validate_and_expand(
        bundle,
        "future",
        False,
    )

    assert len(expanded) == 2
    assert "target_value" not in expanded
    assert model_features[-1] == "horizon_step"
    assert categorical == []
    assert not (outcome.bundle_path / "labels").exists()
    assert bundle.manifest["processing_mode"] == "future"


@pytest.mark.integration
def test_skill2_writer_rejects_forecast_feature_name_collision(tmp_path: Path) -> None:
    request = _future_request()
    colliding_catalog = (
        FeatureCatalogEntry(
            feature_name="calendar_hour",
            data_type="numeric",
            source_point_id="BMS-TARGET",
            semantic_version="duplicate-v1",
        ),
    )
    start = datetime(2026, 2, 1, tzinfo=UTC)
    colliding_feature = FeatureSetRow(
        sample_id="future-001",
        feature_cutoff_timestamp=start,
        forecast_start_timestamp=start,
        forecast_end_timestamp=start + timedelta(minutes=1),
        calendar_hour=1.0,
    )

    with pytest.raises(ValueError, match="reserved forecast columns"):
        LocalProcessingBundleWriter(tmp_path).write(
            replace(
                request,
                feature_catalog=colliding_catalog,
                features={"future": (colliding_feature,)},
            )
        )
