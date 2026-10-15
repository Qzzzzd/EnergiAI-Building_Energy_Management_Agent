from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from load_forecasting.bundle import estimate_resources, load_processing_bundle, schema_fingerprint, validate_and_expand
from load_forecasting.errors import ForecastError
from load_forecasting.mock import create_mock_processing_bundle
from load_forecasting.modeling import compute_metrics


def test_metrics_and_zero_mean() -> None:
    metrics = compute_metrics(np.array([10.0, 12.0]), np.array([9.0, 13.0]))
    assert metrics["rmse"] == pytest.approx(1.0)
    assert metrics["mae"] == pytest.approx(1.0)
    assert metrics["cvrmse_percent"] == pytest.approx(100 / 11)
    zero = compute_metrics(np.array([-1.0, 1.0]), np.array([0.0, 0.0]))
    assert zero["rmse"] == pytest.approx(1.0)
    assert zero["cvrmse_percent"] is None


def test_schema_fingerprint_is_order_sensitive() -> None:
    catalog = pd.DataFrame(
        [
            {"feature_name": "a", "data_type": "numeric", "source_point_id": "x", "semantic_version": "1"},
            {"feature_name": "b", "data_type": "boolean", "source_point_id": "y", "semantic_version": "1"},
        ]
    )
    assert schema_fingerprint(catalog) != schema_fingerprint(catalog.iloc[::-1].reset_index(drop=True))


def test_bundle_validation_expansion_and_resource_estimate(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path)
    bundle = load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")
    expanded, features, categorical = validate_and_expand(bundle, "train", True)
    assert len(expanded) == 24 * 8
    assert "horizon_step" in features
    assert categorical == ["operating_mode"]
    estimate = estimate_resources(bundle, ("train",), 1024**3, 1024**3)
    assert estimate["expanded_rows"] == 24 * 8


def test_leakage_gate_and_hash_mismatch(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path)
    root = Path(fixture["path"])
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["leakage_check_status"] = "failed"
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ForecastError, match="LEAKAGE_CHECK_NOT_PASSED"):
        load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")


def test_resource_budget_rejection(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path)
    bundle = load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")
    with pytest.raises(ForecastError, match="RESOURCE_BUDGET_EXCEEDED"):
        estimate_resources(bundle, ("train",), 1, 1)


def test_invalid_infinite_feature(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path)
    root = Path(fixture["path"])
    path = root / "features" / "split=train" / "data.parquet"
    frame = pd.read_parquet(path)
    frame.loc[0, "outdoor_temp"] = np.inf
    frame.to_parquet(path, index=False)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    from load_forecasting.util import sha256_file

    manifest["file_hashes"]["features/split=train/data.parquet"] = sha256_file(path)
    manifest_path.write_text(json.dumps(manifest))
    bundle = load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")
    with pytest.raises(ForecastError, match="INVALID_FEATURE_VALUE"):
        validate_and_expand(bundle, "train", True)


def test_declared_processing_mode_must_match_request(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path, "future")
    with pytest.raises(ForecastError, match="INCOMPATIBLE_PROCESSING_BUNDLE"):
        load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")


def test_feature_and_forecast_index_names_must_not_overlap(tmp_path: Path) -> None:
    fixture = create_mock_processing_bundle(tmp_path)
    root = Path(fixture["path"])
    feature_path = root / "features" / "split=train" / "data.parquet"
    features = pd.read_parquet(feature_path)
    features["calendar_hour"] = 1
    features.to_parquet(feature_path, index=False)
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    from load_forecasting.util import sha256_file

    manifest["file_hashes"]["features/split=train/data.parquet"] = sha256_file(feature_path)
    manifest_path.write_text(json.dumps(manifest))
    bundle = load_processing_bundle(tmp_path, fixture["processing_bundle_id"], "backtest")
    with pytest.raises(ForecastError, match="FEATURE_NAME_COLLISION"):
        validate_and_expand(bundle, "train", True)
