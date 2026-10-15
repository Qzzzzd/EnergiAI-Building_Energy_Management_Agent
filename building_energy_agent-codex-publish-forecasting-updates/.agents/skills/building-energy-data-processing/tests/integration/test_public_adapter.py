from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = SKILL_ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))

from skill_adapter import execute


def _dataset_fixture(artifact_root: Path) -> str:
    helper_path = Path(__file__).with_name("test_skill2_service_to_skill4.py")
    spec = importlib.util.spec_from_file_location("processing_dataset_fixture", helper_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._write_eleven_day_dataset_bundle(artifact_root)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_real_adapter_publishes_processing_manifest_without_bulk_files(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    artifact_root = workspace / "artifacts"
    artifact_root.mkdir(parents=True)
    dataset_bundle_id = _dataset_fixture(artifact_root)
    dataset_root = artifact_root / "dataset-bundles" / dataset_bundle_id
    _write_json(
        artifact_root / "public-artifacts" / "artifact-dataset" / "native-manifest.json",
        json.loads((dataset_root / "manifest.json").read_text(encoding="utf-8")),
    )
    _write_json(
        artifact_root / "public-artifacts" / "artifact-dataset" / "manifest.json",
        {
            "artifact_type": "DatasetBundle",
            "source_ids": ["src:processing-upload"],
            "files": [
                {
                    "role": "native-manifest",
                    "relative_path": "public-artifacts/artifact-dataset/native-manifest.json",
                }
            ],
        },
    )

    request = {
        "source_bundle_id": dataset_bundle_id,
        "target": {"point_id": "BMS-TARGET"},
        "prediction_spec": {"forecast_horizon": "1h"},
        "feature_spec": {"preset": "target-history-v1"},
        "data_scope": {"local_timezone": "UTC"},
        "split_spec": {"anchor_time": "00:00"},
    }
    job_dir = workspace / ".be-skill-jobs" / "building-energy-data-processing" / "job-public-processing"
    job_dir.mkdir(parents=True)
    outcome = execute(
        request=request,
        answers=None,
        job_dir=job_dir,
        workspace_root=workspace,
        artifact_root=artifact_root,
        progress=lambda *_args: None,
    )

    assert outcome["status"] in {"succeeded", "partial"}
    reference = outcome["artifact_refs"][0]
    assert reference["artifact_type"] == "ProcessingBundle"
    assert not reference["manifest_relative_path"].startswith("artifacts/")
    manifest = json.loads(
        (artifact_root / reference["manifest_relative_path"]).read_text(encoding="utf-8")
    )
    assert manifest["schema_version"] == "1.0"
    assert manifest["source_ids"] == ["src:processing-upload"]
    assert {item["role"] for item in manifest["files"]} >= {
        "summary",
        "native-manifest",
        "report",
        "visualization",
    }
    descriptors = manifest["summary"]["visualizations"]
    assert descriptors == sorted(descriptors, key=lambda item: item["display_order"])
    assert all(
        set(item) >= {"chart_id", "title", "display_order", "file_name", "business_category"}
        for item in descriptors
    )
    assert all(item["file_name"].endswith(".png") for item in descriptors)
    for item in manifest["files"]:
        assert not item["relative_path"].endswith(".parquet")
        path = artifact_root / item["relative_path"]
        assert path.stat().st_size == item["size_bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
