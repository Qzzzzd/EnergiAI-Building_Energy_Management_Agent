from __future__ import annotations

import json
from pathlib import Path

from create_fixture import create_fixture
from data_quality_assessment import jobs as quality_jobs
from data_quality_assessment.jobs import JobStore, result_for, resume_job, run_worker, start_job


def _spec(path: Path, bundle_id: str = "fixture", target_point_id: str = "target-load") -> Path:
    path.write_text(
        json.dumps({
            "source_bundle_id": bundle_id,
            "assessment_context": {"task_type": "load_forecasting", "target_point_id": target_point_id},
        }),
        encoding="utf-8",
    )
    return path


def test_end_to_end_job_and_idempotent_start(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    spec = _spec(tmp_path / "request.json")
    first = start_job(spec, tmp_path, launch_worker=False)
    second = start_job(spec, tmp_path, launch_worker=False)
    assert first["job_id"] == second["job_id"]
    run_worker(first["job_id"], tmp_path)
    status = JobStore(tmp_path).read(first["job_id"])
    assert status["status"] == "succeeded"
    output = result_for(first["job_id"], tmp_path)
    report = Path(output["quality_report"]).read_text(encoding="utf-8")
    assert "# 数据质量评估报告" in report
    assert "综合得分" in report
    bundle_root = Path(output["manifest"]).parent
    assert {path.name for path in bundle_root.iterdir()} == {
        "manifest.json", "quality_result.json", "quality_profile.json", "quality_report.md"
    }


def test_cached_successful_job_republishes_visualizations(tmp_path, monkeypatch) -> None:
    create_fixture(tmp_path, "fixture")
    spec = _spec(tmp_path / "request.json")
    started = start_job(spec, tmp_path, launch_worker=False)
    JobStore(tmp_path).write(
        started["job_id"],
        {
            "job_id": started["job_id"],
            "status": "succeeded",
            "quality_assessment_bundle_id": "qabundle-cached",
            "warnings": [],
        },
    )
    published: list[Path] = []

    def fake_publish(bundle_root: Path, *, artifact_root: Path) -> Path:
        published.append(bundle_root)
        return bundle_root / "manifest.json"

    monkeypatch.setattr(
        "data_quality_assessment.visualization.publish_visualizations",
        fake_publish,
    )
    cached = start_job(spec, tmp_path, launch_worker=False)

    assert cached["job_id"] == started["job_id"]
    assert published == [tmp_path / "quality-assessment-bundles" / "qabundle-cached"]


def test_missing_optional_semantics_still_assesses(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    points_path = tmp_path / "dataset-bundles" / "fixture" / "points.parquet"
    import pandas as pd
    points = pd.read_parquet(points_path)
    points.loc[points["point_id"] == "wet-bulb", ["name", "description"]] = ["unknown", "unknown"]
    points.to_parquet(points_path, index=False)
    job = start_job(_spec(tmp_path / "request.json"), tmp_path, launch_worker=False)
    run_worker(job["job_id"], tmp_path)
    status = JobStore(tmp_path).read(job["job_id"])
    assert status["status"] == "succeeded"
    result = json.loads(Path(result_for(job["job_id"], tmp_path)["quality_result"]).read_text(encoding="utf-8"))
    assert result["effective_scope"]["included_point_count"] == 9
    assert result["overall_score"] is not None
    assert any(issue["issue_type"] == "MISSING_EXPECTED_FEATURES" for issue in result["issues"])


def test_resume_same_job_with_confirmed_profile(tmp_path, monkeypatch) -> None:
    create_fixture(tmp_path, "fixture")
    original_builder = quality_jobs.build_mvp_profile

    def pause_for_confirmation(*args, **kwargs):
        profile, _ = original_builder(*args, **kwargs)
        return profile, [{"parameter": "variables.wet_bulb.point_ids", "reason": "AMBIGUOUS_SEMANTIC_MATCH"}]

    monkeypatch.setattr(quality_jobs, "build_mvp_profile", pause_for_confirmation)
    job = start_job(_spec(tmp_path / "request.json"), tmp_path, launch_worker=False)
    run_worker(job["job_id"], tmp_path)
    status = JobStore(tmp_path).read(job["job_id"])
    candidate_path = Path(status["candidate_profile"])
    candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
    candidate["quality_profile_id"] = None
    confirmed = tmp_path / "confirmed-profile.json"
    confirmed.write_text(json.dumps(candidate, ensure_ascii=False), encoding="utf-8")
    resumed = resume_job(job["job_id"], confirmed, tmp_path, launch_worker=False)
    assert resumed["job_id"] == job["job_id"]
    run_worker(job["job_id"], tmp_path)
    assert JobStore(tmp_path).read(job["job_id"])["status"] == "succeeded"


def test_195_point_partitioned_read_smoke(tmp_path) -> None:
    create_fixture(tmp_path, "scale", point_count=195, periods=120)
    job = start_job(_spec(tmp_path / "request.json", "scale"), tmp_path, launch_worker=False)
    run_worker(job["job_id"], tmp_path)
    status = JobStore(tmp_path).read(job["job_id"])
    assert status["status"] == "succeeded"
    result = json.loads(Path(result_for(job["job_id"], tmp_path)["quality_result"]).read_text(encoding="utf-8"))
    assert result["effective_scope"]["included_point_count"] == 195
