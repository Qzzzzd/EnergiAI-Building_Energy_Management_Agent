from __future__ import annotations

import base64
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from load_forecasting.modeling import _plot_pair_frame, _render_figures, compute_metrics
from load_forecasting.visualization import (
    ForecastVisualizationRenderer,
    publish_visualizations,
    validate_manifest,
)


_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


@pytest.mark.parametrize(
    ("value", "expected_count"),
    [
        (
            pd.DataFrame(
                {
                    "evaluation_eligible": [True, False],
                    "actual_value": [1.0, 2.0],
                    "prediction": [1.1, 2.1],
                }
            ),
            1,
        ),
        (
            pd.DataFrame(
                {
                    "evaluation_eligible": [True],
                    "actual_value": [1.0],
                    "prediction": [1.1],
                }
            ),
            1,
        ),
        (
            pd.Series(
                {
                    "evaluation_eligible": True,
                    "actual_value": 1.0,
                    "prediction": 1.1,
                }
            ),
            1,
        ),
        (np.float64(1.0), 0),
        (
            pd.DataFrame(
                {
                    "evaluation_eligible": [True, True],
                    "actual_value": [np.nan, np.nan],
                    "prediction": [1.0, 1.1],
                }
            ),
            0,
        ),
        (pd.DataFrame(columns=["evaluation_eligible", "actual_value", "prediction"]), 0),
    ],
)
def test_plot_pair_frame_normalises_shapes_and_filters_finite_pairs(value: object, expected_count: int) -> None:
    result = _plot_pair_frame(value)
    assert isinstance(result, pd.DataFrame)
    assert {"actual_value", "prediction"}.issubset(result.columns)
    assert len(result) == expected_count
    assert np.isfinite(result["actual_value"].to_numpy(dtype=float)).all()
    assert np.isfinite(result["prediction"].to_numpy(dtype=float)).all()


def test_render_figures_skips_scatter_for_one_pair_without_declaring_a_file(tmp_path: Path) -> None:
    predictions = pd.DataFrame(
        {
            "evaluation_eligible": [True],
            "actual_value": [1.0],
            "prediction": [1.1],
            "residual": [-0.1],
            "target_timestamp": [pd.Timestamp("2026-01-01")],
        }
    )
    missing, warnings = _render_figures(
        tmp_path,
        predictions,
        pd.DataFrame({"feature_name": ["x"], "gain": [1.0]}),
    )
    assert missing == []
    assert any("DISPLAY_INSUFFICIENT_PAIRED_SAMPLES" in warning for warning in warnings)
    assert not (tmp_path / "figures" / "test_actual_vs_prediction_scatter.png").exists()
    assert (tmp_path / "figures" / "test_actual_vs_prediction.png").is_file()


def test_scalar_metrics_are_safe_and_unpaired_metrics_are_domain_errors() -> None:
    assert compute_metrics(np.float64(1.0), np.float64(1.1))["count"] == 1
    with pytest.raises(Exception, match="PREDICTION_SHAPE_MISMATCH"):
        compute_metrics(np.array([1.0, 2.0]), np.array([1.0]))


def test_visualization_bundle_skips_scatter_without_nonexistent_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "evaluation-bundles" / "evaluation-one"
    (root / "predictions").mkdir(parents=True)
    pq.write_table(
        pa.table(
            {
                "target_timestamp": ["2026-01-01T00:00:00+00:00"],
                "actual_value": [1.0],
                "prediction": [1.1],
                "residual": [-0.1],
                "horizon_step": [1],
                "evaluation_eligible": [True],
            }
        ),
        root / "predictions" / "test.parquet",
    )
    (root / "metrics.json").write_text(
        json.dumps({"validation": {}, "test": {}, "test_by_horizon": []}),
        encoding="utf-8",
    )
    (root / "training_history.json").write_text("{}", encoding="utf-8")
    pq.write_table(
        pa.table({"feature_name": ["x"], "gain": [1.0]}),
        root / "feature_importance.parquet",
    )
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "bundle_type": "EvaluationBundle",
                "bundle_version": "0.7",
                "evaluation_bundle_id": "evaluation-one",
                "model_bundle_id": "model-one",
                "processing_bundle_id": "processing-one",
                "file_hashes": {},
            }
        ),
        encoding="utf-8",
    )

    def fake_render(self: ForecastVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(ForecastVisualizationRenderer, "render", fake_render)
    manifest_path = publish_visualizations(root, artifact_root=tmp_path)
    manifest = validate_manifest(manifest_path)
    scatter = next(item for item in manifest["figures"] if item["chart_id"] == "actual_vs_prediction_scatter")
    assert manifest["status"] == "partial"
    assert scatter["status"] == "not_applicable"
    assert "relative_path" not in scatter
    assert "figures/actual_vs_prediction_scatter.png" not in manifest["file_hashes"]
