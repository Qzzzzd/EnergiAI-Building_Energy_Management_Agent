from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from building_energy_agent.skills.skill2_processing.visualization import (
    ProcessingVisualizationRenderer,
    publish_visualizations,
    validate_manifest,
)

_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def test_skill2_visualization_keeps_source_and_writes_hashes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    root = tmp_path / "processing-bundles" / "processing-test"
    (root / "data" / "processed_timeseries").mkdir(parents=True)
    start = datetime(2026, 1, 1, tzinfo=UTC)
    pq.write_table(pa.table({"timestamp": pa.array([start + timedelta(minutes=i) for i in range(3)], type=pa.timestamp("us", tz="UTC")), "target_value": [1.0, None, 3.0], "is_observed": [True, False, True], "gap_class": ["observed", "long_gap", "observed"], "segment_id": [1, None, 2]}), root / "data" / "processed_timeseries" / "target.parquet")
    for name, value in {
        "manifest.json": {"bundle_type": "ProcessingBundle", "bundle_version": "0.7", "processing_bundle_id": "processing-test", "processing_mode": "backtest"},
        "processing_report.json": {"status": "succeeded", "sample_plan_exclusion_counts": {"bad_day": 1}},
        "split_manifest.json": {"mode": "backtest", "splits": {"train": {"sample_count": 2, "forecast_start": start.isoformat(), "forecast_end": (start + timedelta(minutes=1)).isoformat()}}},
        "target_metadata.json": {"target_name": "目标", "target_unit": "kW"},
    }.items():
        (root / name).write_text(json.dumps(value), encoding="utf-8")
    before = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}

    def fake_render(self: ProcessingVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(ProcessingVisualizationRenderer, "render", fake_render)
    output = publish_visualizations(root, artifact_root=tmp_path)
    manifest = validate_manifest(output)
    assert manifest["renderer_set_version"] == "skill2-visual-v3"
    assert manifest["source"]["bundle_id"] == "processing-test"
    assert len(manifest["file_hashes"]) >= 2
    assert {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()} == before
