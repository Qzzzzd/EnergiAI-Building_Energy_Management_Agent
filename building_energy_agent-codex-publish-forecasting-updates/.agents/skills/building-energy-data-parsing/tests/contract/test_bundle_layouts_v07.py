from pathlib import PurePosixPath

import pytest

from building_energy_agent.contracts.bundle_layouts import (
    DATASET_BUNDLE_V07,
    PROCESSING_BACKTEST_BUNDLE_V07,
    PROCESSING_BUNDLE_V07,
    PROCESSING_COMMON_REQUIRED_FILES_V07,
    PROCESSING_FUTURE_BUNDLE_V07,
    PROCESSING_FUTURE_REQUIRED_FILES_V07,
    BundleLayout,
)


def test_dataset_bundle_paths_match_v07() -> None:
    assert set(DATASET_BUNDLE_V07.required_paths) == {
        "manifest.json",
        "data/timeseries",
        "data/tables",
        "points.parquet",
        "parse_report.json",
    }


def test_processing_backtest_bundle_paths_match_v07() -> None:
    assert PROCESSING_BUNDLE_V07 is PROCESSING_BACKTEST_BUNDLE_V07
    assert set(PROCESSING_BACKTEST_BUNDLE_V07.required_paths) == {
        "manifest.json",
        "data/processed_timeseries",
        "features/split=train",
        "features/split=validation",
        "features/split=test",
        "labels/split=train",
        "labels/split=validation",
        "labels/split=test",
        "feature_catalog.parquet",
        "categorical_mappings.json",
        "features/split=train/data.parquet",
        "features/split=validation/data.parquet",
        "features/split=test/data.parquet",
        "labels/split=train/data.parquet",
        "labels/split=validation/data.parquet",
        "labels/split=test/data.parquet",
        "forecast_index/split=train",
        "forecast_index/split=validation",
        "forecast_index/split=test",
        "forecast_index/split=train/data.parquet",
        "forecast_index/split=validation/data.parquet",
        "forecast_index/split=test/data.parquet",
        "target_metadata.json",
        "split_manifest.json",
        "processing_report.json",
    }


def test_processing_future_bundle_paths_match_v07() -> None:
    assert set(PROCESSING_FUTURE_BUNDLE_V07.required_paths) == {
        *PROCESSING_COMMON_REQUIRED_FILES_V07,
        "data/processed_timeseries",
        "features/split=future",
        "features/split=future/data.parquet",
        "forecast_index/split=future",
        "forecast_index/split=future/data.parquet",
    }
    assert not any(
        "split=train" in path
        or "split=validation" in path
        or "split=test" in path
        or "labels/split=future" in path
        for path in PROCESSING_FUTURE_BUNDLE_V07.required_paths
    )


def test_all_bundle_paths_are_relative() -> None:
    for layout in (
        DATASET_BUNDLE_V07,
        PROCESSING_BACKTEST_BUNDLE_V07,
        PROCESSING_FUTURE_BUNDLE_V07,
    ):
        for path_text in layout.required_paths:
            path = PurePosixPath(path_text)
            assert not path.is_absolute()
            assert ".." not in path.parts


def test_processing_future_paths_are_fixed() -> None:
    assert PROCESSING_FUTURE_REQUIRED_FILES_V07 == (
        "features/split=future/data.parquet",
        "forecast_index/split=future/data.parquet",
    )


def test_frozen_bundle_outputs_are_not_omitted() -> None:
    assert {
        "manifest.json",
        "points.parquet",
        "parse_report.json",
    }.issubset(DATASET_BUNDLE_V07.required_files)
    assert {
        "manifest.json",
        "feature_catalog.parquet",
        "categorical_mappings.json",
        "target_metadata.json",
        "split_manifest.json",
        "processing_report.json",
    }.issubset(PROCESSING_BACKTEST_BUNDLE_V07.required_files)
    assert set(PROCESSING_COMMON_REQUIRED_FILES_V07).issubset(
        PROCESSING_FUTURE_BUNDLE_V07.required_files
    )


def _materialize_layout(root, layout: BundleLayout) -> None:
    for relative in layout.required_directories:
        (root / relative).mkdir(parents=True, exist_ok=True)
    for relative in layout.required_files:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()


@pytest.mark.parametrize(
    "layout",
    [PROCESSING_BACKTEST_BUNDLE_V07, PROCESSING_FUTURE_BUNDLE_V07],
)
def test_mode_specific_minimum_layout_validates(tmp_path, layout: BundleLayout) -> None:
    _materialize_layout(tmp_path, layout)
    layout.validate(tmp_path)


def test_future_layout_requires_every_common_metadata_file(tmp_path) -> None:
    _materialize_layout(tmp_path, PROCESSING_FUTURE_BUNDLE_V07)
    (tmp_path / "target_metadata.json").unlink()

    with pytest.raises(ValueError, match="target_metadata.json"):
        PROCESSING_FUTURE_BUNDLE_V07.validate(tmp_path)


@pytest.mark.parametrize(
    "missing",
    [
        "features/split=train/data.parquet",
        "labels/split=validation/data.parquet",
        "forecast_index/split=test/data.parquet",
    ],
)
def test_backtest_layout_rejects_missing_partition_file(tmp_path, missing: str) -> None:
    _materialize_layout(tmp_path, PROCESSING_BACKTEST_BUNDLE_V07)
    (tmp_path / missing).unlink()

    with pytest.raises(ValueError, match=missing):
        PROCESSING_BACKTEST_BUNDLE_V07.validate(tmp_path)
