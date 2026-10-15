from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from building_energy_agent.skills.skill1_parse.visualization import (
    DatasetVisualizationRenderer,
    publish_visualizations,
    validate_manifest,
)

_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "YAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_skill1_manifest_hash_source_unchanged_and_failed_chart_isolated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pa = pytest.importorskip("pyarrow")
    pq = pytest.importorskip("pyarrow.parquet")
    root = tmp_path / "dataset-bundles" / "dataset-test"
    (root / "data" / "timeseries").mkdir(parents=True)
    (root / "data" / "tables").mkdir(parents=True)
    timestamps = [datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=i) for i in range(3)]
    pq.write_table(pa.table({"timestamp": pa.array(timestamps, type=pa.timestamp("us", tz="UTC")), "point_id": ["p1"] * 3, "value_raw": [1.0, 2.0, 3.0]}), root / "data" / "timeseries" / "sheet.parquet")
    pq.write_table(pa.table({"point_id": ["p1"], "name": ["P1"], "unit": ["kW"]}), root / "points.parquet")
    manifest = {"bundle_type": "DatasetBundle", "bundle_version": "0.7", "dataset_bundle_id": "dataset-test", "time_start": timestamps[0].isoformat(), "time_end": timestamps[-1].isoformat()}
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "parse_report.json").write_text(json.dumps({"dataset_bundle_id": "dataset-test", "record_count": 3, "worksheet_count": 1, "worksheets": [{"output_partition": "data/timeseries/sheet.parquet", "time_start": timestamps[0].isoformat(), "time_end": timestamps[-1].isoformat()}]}), encoding="utf-8")
    before = {path.relative_to(root).as_posix(): _sha(path) for path in root.rglob("*") if path.is_file()}

    def fake_render(self: DatasetVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(DatasetVisualizationRenderer, "render", fake_render)
    manifest_path = publish_visualizations(root, artifact_root=tmp_path, fail_charts=("observations_by_point",))
    published = validate_manifest(manifest_path)
    assert published["renderer_set_version"] == "skill1-visual-v3"
    assert any(item["chart_id"] == "dataset_overview" and item["status"] == "available" for item in published["figures"])
    assert any(item["chart_id"] == "observations_by_point" and item["status"] == "failed" for item in published["figures"])
    assert {path.relative_to(root).as_posix(): _sha(path) for path in root.rglob("*") if path.is_file()} == before
