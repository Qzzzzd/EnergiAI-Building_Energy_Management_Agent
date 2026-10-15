from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from load_forecasting.mock import create_mock_processing_bundle
from skill_adapter import execute


def _write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _execute(request: dict, job_dir: Path, workspace: Path, artifact_root: Path) -> dict:
    job_dir.mkdir(parents=True)
    return execute(
        request=request,
        answers=None,
        job_dir=job_dir,
        workspace_root=workspace,
        artifact_root=artifact_root,
        progress=lambda *_args: None,
    )


def _assert_public_files(artifact_root: Path, reference: dict) -> dict:
    assert not reference["manifest_relative_path"].startswith("artifacts/")
    manifest = json.loads(
        (artifact_root / reference["manifest_relative_path"]).read_text(encoding="utf-8")
    )
    assert manifest["schema_version"] == "1.0"
    assert manifest["artifact_id"] == reference["artifact_id"]
    assert manifest["status"] == reference["status"]
    for item in manifest["files"]:
        assert not Path(item["relative_path"]).is_absolute()
        assert ".." not in Path(item["relative_path"]).parts
        assert not item["relative_path"].endswith((".parquet", ".pkl", "/model.txt"))
        path = artifact_root / item["relative_path"]
        assert path.stat().st_size == item["size_bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
    return manifest


def test_real_adapter_publishes_evaluation_and_bounded_forecast_preview(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    artifact_root = workspace / "artifacts"
    artifact_root.mkdir(parents=True)

    backtest = create_mock_processing_bundle(artifact_root, mode="backtest")
    backtest_root = artifact_root / "processing-bundles" / backtest["processing_bundle_id"]
    _write_json(backtest_root / "processing_report.json", {"local_timezone": "Asia/Shanghai", "horizon_minutes": 8 * 60})
    trained = _execute(
        {
            "processing_bundle_id": backtest["processing_bundle_id"],
            "forecast_spec": {"mode": "backtest"},
            "resource_budget": {"threads": 1},
        },
        workspace / ".be-skill-jobs" / "building-energy-load-forecasting" / "job-public-train",
        workspace,
        artifact_root,
    )
    assert trained["status"] in {"succeeded", "partial"}
    assert {item["artifact_type"] for item in trained["artifact_refs"]} == {"ModelBundle", "EvaluationBundle"}
    public_by_type = {
        reference["artifact_type"]: _assert_public_files(artifact_root, reference)
        for reference in trained["artifact_refs"]
    }
    evaluation_summary = public_by_type["EvaluationBundle"]["summary"]
    assert evaluation_summary["mode"] == "backtest"
    assert evaluation_summary["target_point_id"] == "总冷机冷负荷"
    assert evaluation_summary["timezone"] == "Asia/Shanghai"
    assert evaluation_summary["horizon_hours"] == 8
    assert "metrics" in evaluation_summary
    evaluation_descriptors = evaluation_summary["visualizations"]
    actual_vs_prediction = next(
        item for item in evaluation_descriptors if item["chart_id"] == "actual_vs_prediction"
    )
    assert actual_vs_prediction["title"] == "实际值与预测值对比"
    assert actual_vs_prediction["business_category"] == "load_forecast"
    assert actual_vs_prediction["file_name"] == "figures/actual_vs_prediction.png"

    future = create_mock_processing_bundle(
        artifact_root,
        mode="future",
        forecast_start="2025-10-01T00:00:00+00:00",
    )
    future_root = artifact_root / "processing-bundles" / future["processing_bundle_id"]
    _write_json(future_root / "processing_report.json", {"local_timezone": "Asia/Shanghai", "horizon_minutes": 8 * 60})
    predicted = _execute(
        {
            "model_bundle_id": trained["model_bundle_id"],
            "processing_bundle_id": future["processing_bundle_id"],
            "forecast_spec": {
                "mode": "future",
                "forecast_start": future["forecast_start"],
                "forecast_end": future["forecast_end"],
            },
            "resource_budget": {"threads": 1},
        },
        workspace / ".be-skill-jobs" / "building-energy-load-forecasting" / "job-public-predict",
        workspace,
        artifact_root,
    )
    assert predicted["status"] in {"succeeded", "partial"}
    assert len(predicted["artifact_refs"]) == 1
    manifest = _assert_public_files(artifact_root, predicted["artifact_refs"][0])
    assert manifest["summary"]["mode"] == "future"
    assert manifest["summary"]["prediction_summary"]["prediction_count"] == 8
    future_descriptors = manifest["summary"]["visualizations"]
    assert any(
        item["chart_id"] == "forecast_timeseries" and item["business_category"] == "load_forecast"
        for item in future_descriptors
    )
    preview_entry = next(item for item in manifest["files"] if item["role"] == "forecast-preview")
    preview = json.loads((artifact_root / preview_entry["relative_path"]).read_text(encoding="utf-8"))
    assert len(preview) == 8
    assert set(preview[0]) == {"timestamp", "prediction", "horizon_step", "unit"}
