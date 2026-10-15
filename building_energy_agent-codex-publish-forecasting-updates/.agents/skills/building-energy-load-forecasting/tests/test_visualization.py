from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from load_forecasting.visualization import ForecastVisualizationRenderer, publish_visualizations, validate_manifest

_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def test_forecast_visualization_reuses_existing_png_and_isolates_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "evaluation-bundles" / "evaluation-test"
    (root / "predictions").mkdir(parents=True)
    png = root / "figures" / "test_actual_vs_prediction.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(_PNG)
    digest = hashlib.sha256(_PNG).hexdigest()
    pq.write_table(pa.table({"target_timestamp": ["2026-01-01T00:00:00+00:00"], "actual_value": [1.0], "prediction": [1.1], "residual": [-.1], "horizon_step": [1], "evaluation_eligible": [True]}), root / "predictions" / "test.parquet")
    for name, value in {"metrics.json": {"validation": {}, "test": {}, "test_by_horizon": []}, "training_history.json": {}}.items():
        (root / name).write_text(json.dumps(value), encoding="utf-8")
    pq.write_table(pa.table({"feature_name": ["x"], "gain": [1.0]}), root / "feature_importance.parquet")
    (root / "manifest.json").write_text(json.dumps({"bundle_type": "EvaluationBundle", "bundle_version": "0.7", "evaluation_bundle_id": "evaluation-test", "model_bundle_id": "model-test", "processing_bundle_id": "processing-test", "file_hashes": {"figures/test_actual_vs_prediction.png": digest}}), encoding="utf-8")
    before = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}

    def fake_render(self: ForecastVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(ForecastVisualizationRenderer, "render", fake_render)
    output = publish_visualizations(root, artifact_root=tmp_path, fail_charts=("training_history",))
    manifest = validate_manifest(output)
    entry = next(item for item in manifest["figures"] if item["chart_id"] == "actual_vs_prediction")
    assert entry["generation_mode"] == "reused"
    assert any(item["chart_id"] == "training_history" and item["status"] == "failed" for item in manifest["figures"])
    assert {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()} == before


def test_model_bundle_publishes_model_summary(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "model-bundles" / "model-test"
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"bundle_type": "ModelBundle", "bundle_version": "0.7", "model_bundle_id": "model-test"}), encoding="utf-8")
    (root / "training_summary.json").write_text(json.dumps({"model_type": "ridge", "maximum_horizon_step": 3}), encoding="utf-8")
    (root / "training_config.json").write_text(json.dumps({"model_type": "ridge"}), encoding="utf-8")

    def fake_render(self: ForecastVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(ForecastVisualizationRenderer, "render", fake_render)
    output = publish_visualizations(root, artifact_root=tmp_path)
    manifest = validate_manifest(output)
    assert [item["chart_id"] for item in manifest["figures"]] == ["model_summary"]
    assert manifest["figures"][0]["status"] == "available"


def test_renderer_uses_an_existing_known_cjk_font_or_reports_fallback(tmp_path: Path) -> None:
    matplotlib = pytest.importorskip("matplotlib")
    from matplotlib import font_manager

    renderer = ForecastVisualizationRenderer()
    output = tmp_path / "model-summary.png"
    renderer.render("model_summary", {"model_type": "ridge"}, output)

    known = {
        "microsoft yahei",
        "noto sans cjk sc",
        "simhei",
        "source han sans sc",
    }
    available = {font.name.casefold() for font in font_manager.fontManager.ttflist}
    if known.intersection(available):
        assert matplotlib.rcParams["font.sans-serif"][0].casefold() in known
        assert not any(item["code"] == "DISPLAY_FONT_FALLBACK" for item in renderer.warnings)
    else:
        assert any(item["code"] == "DISPLAY_FONT_FALLBACK" for item in renderer.warnings)
    assert output.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
