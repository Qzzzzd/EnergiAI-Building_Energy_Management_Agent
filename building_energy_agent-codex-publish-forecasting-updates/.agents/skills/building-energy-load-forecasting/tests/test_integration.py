from __future__ import annotations

import json
import time
from pathlib import Path

import pandas as pd
import pytest

from load_forecasting.jobs import get_result, get_status, start_job
from load_forecasting.mock import create_mock_processing_bundle
from load_forecasting.modeling import predict, train_evaluate
from load_forecasting.errors import ForecastError


def _progress(stage: str, percent: int) -> None:
    assert stage
    assert 0 <= percent <= 100


def test_train_evaluate_and_predict(tmp_path: Path) -> None:
    backtest = create_mock_processing_bundle(tmp_path, "backtest")
    trained = train_evaluate({"processing_bundle_id": backtest["processing_bundle_id"]}, tmp_path, _progress)
    model_root = tmp_path / "model-bundles" / trained["model_bundle_id"]
    evaluation_root = tmp_path / "evaluation-bundles" / trained["evaluation_bundle_id"]
    model_manifest = json.loads((model_root / "manifest.json").read_text())
    assert (model_root / model_manifest["model_artifact"]).is_file()
    assert model_manifest["training_scope"] == "all_history_after_test_evaluation"
    leaderboard_types = {
        item["model_type"] for item in trained["summary"]["candidate_leaderboard"]
    }
    assert {"baseline_latest_value", "baseline_previous_day_profile"}.issubset(
        leaderboard_types
    )
    assert len(leaderboard_types) >= 3
    assert (evaluation_root / "metrics.json").is_file()
    test_predictions = pd.read_parquet(evaluation_root / "predictions" / "test.parquet")
    assert len(test_predictions) == 8
    assert test_predictions["evaluation_eligible"].sum() == 6
    assert (test_predictions["prediction"] >= 0).all()

    future = create_mock_processing_bundle(tmp_path, "future")
    forecast = predict(
        {
            "model_bundle_id": trained["model_bundle_id"],
            "processing_bundle_id": future["processing_bundle_id"],
            "forecast_spec": {
                "mode": "future",
                "forecast_start": future["forecast_start"],
                "forecast_end": future["forecast_end"],
            },
        },
        tmp_path,
        _progress,
    )
    forecast_root = tmp_path / "forecast-bundles" / forecast["forecast_bundle_id"]
    predictions = pd.read_parquet(forecast_root / "predictions.parquet")
    assert len(predictions) == 8
    assert not predictions["evaluation_eligible"].any()
    assert (forecast_root / "manifest.json").is_file()


def test_persistent_background_job(tmp_path: Path) -> None:
    backtest = create_mock_processing_bundle(tmp_path, "backtest")
    cli_path = Path(__file__).parents[1] / "scripts" / "load_forecasting_cli.py"
    started = start_job(
        "train_evaluate",
        {"processing_bundle_id": backtest["processing_bundle_id"]},
        tmp_path,
        cli_path,
    )
    deadline = time.monotonic() + 45
    status = get_status(tmp_path, started["job_id"])
    while status["status"] not in {"succeeded", "failed"} and time.monotonic() < deadline:
        time.sleep(0.1)
        status = get_status(tmp_path, started["job_id"])
    assert status["status"] == "succeeded", (tmp_path / "jobs" / started["job_id"] / "job.log").read_text()
    result = get_result(tmp_path, started["job_id"])
    assert result["status"] == "succeeded"
    assert result["model_bundle_id"].startswith("model-")


def test_future_leakage_rule_must_match_trained_model(tmp_path: Path) -> None:
    backtest = create_mock_processing_bundle(tmp_path, "backtest")
    trained = train_evaluate(
        {"processing_bundle_id": backtest["processing_bundle_id"]},
        tmp_path,
        _progress,
    )
    future = create_mock_processing_bundle(tmp_path, "future")
    manifest_path = Path(future["path"]) / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["leakage_check_rule_version"] = "different-rule-v2"
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(ForecastError, match="FEATURE_SCHEMA_MISMATCH"):
        predict(
            {
                "model_bundle_id": trained["model_bundle_id"],
                "processing_bundle_id": future["processing_bundle_id"],
                "forecast_spec": {
                    "mode": "future",
                    "forecast_start": future["forecast_start"],
                    "forecast_end": future["forecast_end"],
                },
            },
            tmp_path,
            _progress,
        )
