from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


PROJECT = Path(__file__).resolve().parents[2]
PARSING_SCRIPTS = PROJECT / ".agents" / "skills" / "building-energy-data-parsing" / "scripts"
QUALITY_SCRIPTS = PROJECT / ".agents" / "skills" / "building-energy-data-quality" / "scripts"
FORECAST_SCRIPTS = PROJECT / ".agents" / "skills" / "building-energy-load-forecasting" / "scripts"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def assert_manifest_matches_contract(manifest_path: Path) -> None:
    script = """
import { readFileSync } from 'node:fs';
import { ArtifactManifestSchema } from './packages/contracts/src/index.ts';
ArtifactManifestSchema.parse(JSON.parse(readFileSync(process.argv[1], 'utf8')));
"""
    checked = subprocess.run(
        [str(PROJECT / "node_modules" / ".bin" / "tsx"), "--eval", script, str(manifest_path)],
        cwd=PROJECT,
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_public_manifest_is_contract_valid_and_uses_artifact_root_paths(tmp_path: Path) -> None:
    public_artifact = load_module("test_public_artifact", PARSING_SCRIPTS / "public_artifact.py")
    artifact_root = tmp_path / "artifacts"
    native = artifact_root / "forecast-bundles" / "forecast-1"
    write_json(native / "manifest.json", {"bundle_type": "ForecastBundle"})
    (native / "forecast_report.md").write_text("# report\n", encoding="utf-8")

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )
    visualization = artifact_root / "visualization-bundles" / "visualization-1"
    figure = visualization / "figures" / "forecast.png"
    figure.parent.mkdir(parents=True)
    figure.write_bytes(png)
    digest = hashlib.sha256(png).hexdigest()
    write_json(
        visualization / "manifest.json",
        {
            "status": "succeeded",
            "source": {"bundle_type": "ForecastBundle", "bundle_id": "forecast-1"},
            "figures": [
                {
                    "chart_id": "forecast",
                    "relative_path": "figures/forecast.png",
                    "status": "available",
                    "sha256": digest,
                }
            ],
            "file_hashes": {"figures/forecast.png": digest},
        },
    )
    figures, visualization_warnings, complete = public_artifact.discover_visualization_pngs(
        artifact_root,
        source_type="ForecastBundle",
        source_id="forecast-1",
    )
    assert complete is True
    assert visualization_warnings == []

    reference = public_artifact.publish_public_artifact(
        artifact_root=artifact_root,
        artifact_id="forecast-1",
        artifact_type="ForecastBundle",
        skill_name="building-energy-load-forecasting",
        job_id="job-bridge-1",
        source_ids=["src:upload-1"],
        status="succeeded",
        summary={"mode": "future", "horizon_hours": 24},
        warnings=[],
        source_files=[
            public_artifact.PublicFile(
                native / "manifest.json",
                "native-manifest.json",
                "application/json; charset=utf-8",
                "native-manifest",
            ),
            public_artifact.PublicFile(
                native / "forecast_report.md",
                "forecast-report.md",
                "text/markdown; charset=utf-8",
                "report",
            ),
            *figures,
        ],
        json_files={"forecast-preview.json": ([{"timestamp": "2026-01-01T00:00:00+00:00", "prediction": 1.0, "horizon_step": 1, "unit": "kW"}], "forecast-preview")},
    )
    assert reference["manifest_relative_path"] == "public-artifacts/forecast-1/manifest.json"
    assert not reference["manifest_relative_path"].startswith("artifacts/")

    manifest_path = artifact_root / reference["manifest_relative_path"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert_manifest_matches_contract(manifest_path)
    assert manifest["source_ids"] == ["src:upload-1"]
    assert {item["role"] for item in manifest["files"]} == {
        "summary",
        "native-manifest",
        "report",
        "visualization",
        "forecast-preview",
    }
    assert not any(
        item["relative_path"].endswith((".parquet", ".pkl", "/model.txt"))
        for item in manifest["files"]
    )
    for item in manifest["files"]:
        assert not Path(item["relative_path"]).is_absolute()
        assert ".." not in Path(item["relative_path"]).parts
        public_file = artifact_root / item["relative_path"]
        assert public_file.is_file()
        assert public_file.stat().st_size == item["size_bytes"]
        assert hashlib.sha256(public_file.read_bytes()).hexdigest() == item["sha256"]


def test_quality_summary_exposes_only_native_public_fields(tmp_path: Path) -> None:
    views = load_module("test_quality_public_views", QUALITY_SCRIPTS / "public_views.py")
    root = tmp_path / "quality"
    write_json(
        root / "quality_result.json",
        {
            "overall_score": 82.5,
            "dimensions": {"DQ1": {"status": "available", "score": 90, "summary": "complete"}},
            "issues": [
                {
                    "severity": "warning",
                    "dimension": "DQ1",
                    "summary": "gaps",
                    "affected_scope": {"point_ids": ["load"]},
                    "recommended_action": "check collection",
                    "issue_type": "MISSING",
                }
            ],
            "effective_scope": {"included_point_count": 1},
        },
    )
    summary = views.quality_summary(root)
    assert summary == {
        "overall_score": 82.5,
        "dimensions": {"DQ1": {"id": "DQ1", "status": "available", "score": 90, "summary": "complete"}},
        "issues": [
            {
                "severity": "warning",
                "dimension": "DQ1",
                "summary": "gaps",
                "evidence": {"point_ids": ["load"]},
                "recommended_action": "check collection",
            }
        ],
        "effective_scope": {"included_point_count": 1},
    }
    assert "conclusion" not in summary
    assert "recommendations" not in summary


def test_downstream_lineage_reuses_registered_upload_source_ids(tmp_path: Path) -> None:
    public_artifact = load_module("test_public_lineage", PARSING_SCRIPTS / "public_artifact.py")
    artifact_root = tmp_path / "artifacts"
    write_json(
        artifact_root / "public-artifacts" / "artifact-1" / "native-manifest.json",
        {"dataset_bundle_id": "dataset-1"},
    )
    write_json(
        artifact_root / "public-artifacts" / "artifact-1" / "manifest.json",
        {
            "artifact_type": "DatasetBundle",
            "source_ids": ["src:upload-1"],
            "files": [
                {
                    "role": "native-manifest",
                    "relative_path": "public-artifacts/artifact-1/native-manifest.json",
                }
            ],
        },
    )
    write_json(
        artifact_root / "dataset-bundles" / "dataset-1" / "parse_report.json",
        {"sources": [{"source_ref": "local-sha256:" + "a" * 64}]},
    )
    write_json(
        artifact_root / "processing-bundles" / "processing-1" / "manifest.json",
        {"source_bundle_id": "dataset-1"},
    )
    assert public_artifact.dataset_source_ids(artifact_root, "dataset-1") == ["src:upload-1"]
    assert public_artifact.processing_source_ids(artifact_root, "processing-1") == ["src:upload-1"]


def test_evaluation_and_forecast_views_use_native_metadata_and_bound_preview(tmp_path: Path) -> None:
    views = load_module("test_forecast_public_views", FORECAST_SCRIPTS / "public_views.py")
    artifact_root = tmp_path / "artifacts"
    processing = artifact_root / "processing-bundles" / "processing-eval"
    write_json(processing / "manifest.json", {"processing_mode": "backtest"})
    write_json(processing / "target_metadata.json", {"target_point_id": "load", "target_unit": "kW"})
    write_json(processing / "processing_report.json", {"local_timezone": "Asia/Shanghai", "horizon_minutes": 1440})
    write_json(
        processing / "split_manifest.json",
        {"splits": {"test": {"forecast_start": "2026-01-01T00:00:00+08:00", "forecast_end": "2026-01-02T00:00:00+08:00"}}},
    )

    evaluation = artifact_root / "evaluation-bundles" / "evaluation-1"
    write_json(evaluation / "manifest.json", {"processing_bundle_id": "processing-eval"})
    write_json(evaluation / "metrics.json", {"primary_metric": "cvrmse_percent", "test": {"cvrmse_percent": 3.1}})
    evaluation_summary = views.evaluation_summary(evaluation, artifact_root)
    assert evaluation_summary == {
        "mode": "backtest",
        "target_point_id": "load",
        "timezone": "Asia/Shanghai",
        "horizon_hours": 24,
        "start_at": "2026-01-01T00:00:00+08:00",
        "end_at": "2026-01-02T00:00:00+08:00",
        "metrics": {"primary_metric": "cvrmse_percent", "test": {"cvrmse_percent": 3.1}},
    }

    processing = artifact_root / "processing-bundles" / "processing-future"
    write_json(processing / "manifest.json", {"processing_mode": "future"})
    write_json(processing / "target_metadata.json", {"target_point_id": "load", "target_unit": "kW"})
    write_json(processing / "processing_report.json", {"local_timezone": "Asia/Shanghai", "horizon_minutes": 1440})
    write_json(processing / "split_manifest.json", {"splits": {}})

    forecast = artifact_root / "forecast-bundles" / "forecast-1"
    write_json(
        forecast / "manifest.json",
        {
            "processing_bundle_id": "processing-future",
            "forecast_start": "2026-02-01T00:00:00+08:00",
            "forecast_end": "2026-02-09T12:00:00+08:00",
            "summary": {"prediction_count": 205},
        },
    )
    start = datetime(2026, 2, 1, tzinfo=UTC)
    pq.write_table(
        pa.table(
            {
                "target_timestamp": [start + timedelta(hours=index) for index in range(205)],
                "prediction": [float(index) for index in range(205)],
                "horizon_step": list(range(1, 206)),
            }
        ),
        forecast / "predictions.parquet",
    )
    forecast_summary = views.forecast_summary(forecast, artifact_root)
    assert forecast_summary["prediction_summary"] == {"prediction_count": 205}
    assert forecast_summary["mode"] == "future"
    assert forecast_summary["timezone"] == "Asia/Shanghai"
    assert forecast_summary["horizon_hours"] == 24
    assert forecast_summary["start_at"] == "2026-02-01T00:00:00+08:00"
    assert forecast_summary["end_at"] == "2026-02-09T12:00:00+08:00"
    assert "metrics" not in forecast_summary

    preview = views.forecast_preview(forecast, artifact_root)
    assert len(preview) == 200
    assert preview[0] == {
        "timestamp": "2026-02-01T00:00:00+00:00",
        "prediction": 0.0,
        "horizon_step": 1,
        "unit": "kW",
    }
    assert preview[-1]["horizon_step"] == 200
