from __future__ import annotations

import hashlib
import json
from pathlib import Path

from create_fixture import create_fixture
from skill_adapter import execute


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def test_real_adapter_publishes_quality_summary_and_registered_lineage(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    artifact_root = workspace / "artifacts"
    artifact_root.mkdir(parents=True)
    dataset_root = create_fixture(artifact_root, "dataset-public")
    _write_json(
        artifact_root / "public-artifacts" / "artifact-dataset" / "native-manifest.json",
        json.loads((dataset_root / "manifest.json").read_text(encoding="utf-8")),
    )
    _write_json(
        artifact_root / "public-artifacts" / "artifact-dataset" / "manifest.json",
        {
            "artifact_type": "DatasetBundle",
            "source_ids": ["src:quality-upload"],
            "files": [
                {
                    "role": "native-manifest",
                    "relative_path": "public-artifacts/artifact-dataset/native-manifest.json",
                }
            ],
        },
    )

    request = {
        "source_bundle_id": "dataset-public",
        "assessment_context": {"task_type": "load_forecasting", "target_point_id": "target-load"},
    }
    job_dir = workspace / ".be-skill-jobs" / "building-energy-data-quality" / "job-public-quality"
    _write_json(job_dir / "request.json", request)
    outcome = execute(
        request=request,
        answers=None,
        job_dir=job_dir,
        workspace_root=workspace,
        artifact_root=artifact_root,
        progress=lambda *_args: None,
    )

    assert outcome["status"] in {"succeeded", "partial"}
    assert set(outcome["summary"]) >= {"overall_score", "dimensions", "issues", "effective_scope"}
    assert "conclusion" not in outcome["summary"]
    assert "recommendations" not in outcome["summary"]
    assert all(set(item) >= {"id", "status", "score", "summary"} for item in outcome["summary"]["dimensions"].values())
    assert all(
        set(item) >= {"severity", "dimension", "summary", "evidence", "recommended_action"}
        for item in outcome["summary"]["issues"]
    )

    reference = outcome["artifact_refs"][0]
    assert not reference["manifest_relative_path"].startswith("artifacts/")
    manifest = json.loads(
        (artifact_root / reference["manifest_relative_path"]).read_text(encoding="utf-8")
    )
    assert manifest["schema_version"] == "1.0"
    assert manifest["artifact_type"] == "QualityAssessmentBundle"
    assert manifest["source_ids"] == ["src:quality-upload"]
    assert {item["role"] for item in manifest["files"]} >= {
        "summary",
        "native-manifest",
        "report",
        "visualization",
    }
    descriptors = manifest["summary"]["visualizations"]
    assert descriptors[0]["business_category"] == "data_quality"
    assert descriptors[0]["file_name"].endswith(".png")
    assert [item["display_order"] for item in descriptors] == sorted(
        item["display_order"] for item in descriptors
    )
    for item in manifest["files"]:
        assert not item["relative_path"].endswith(".parquet")
        path = artifact_root / item["relative_path"]
        assert path.stat().st_size == item["size_bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == item["sha256"]
