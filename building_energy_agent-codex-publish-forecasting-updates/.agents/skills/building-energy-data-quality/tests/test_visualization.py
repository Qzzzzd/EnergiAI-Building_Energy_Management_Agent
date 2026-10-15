from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest

from data_quality_assessment.visualization import QualityVisualizationRenderer, publish_visualizations, validate_manifest

_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


def test_quality_visualization_supports_empty_optional_data_and_hashes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "quality-assessment-bundles" / "qabundle-test"
    root.mkdir(parents=True)
    (root / "manifest.json").write_text(json.dumps({"bundle_type": "QualityAssessmentBundle", "bundle_version": "0.7", "quality_assessment_bundle_id": "qabundle-test", "source_bundle_id": "dataset-test"}), encoding="utf-8")
    (root / "quality_result.json").write_text(json.dumps({"source_bundle_id": "dataset-test", "overall_score": None, "dimensions": {}, "issues": [], "effective_scope": {}}), encoding="utf-8")
    before = {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()}

    def fake_render(self: QualityVisualizationRenderer, chart_id: str, payload: object, path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(_PNG)
        return 1, 1

    monkeypatch.setattr(QualityVisualizationRenderer, "render", fake_render)
    output = publish_visualizations(root, artifact_root=tmp_path, fail_charts=("issue_severity_counts",))
    manifest = validate_manifest(output)
    assert manifest["renderer_set_version"] == "skill3-visual-v3"
    assert manifest["status"] == "partial"
    assert any(item["status"] == "failed" for item in manifest["figures"])
    assert "summary.json" in manifest["file_hashes"]
    assert {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in root.rglob("*") if path.is_file()} == before
