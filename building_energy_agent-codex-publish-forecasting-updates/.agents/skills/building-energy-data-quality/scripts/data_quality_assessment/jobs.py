from __future__ import annotations

import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .bundle import load_dataset_bundle
from .engine import assess
from .errors import QualityError
from .models import (
    QualityAssessmentBundleManifest,
    QualityAssessmentSpec,
    QualityProfile,
)
from .profile import build_mvp_profile, ensure_compatible, finalize_profile, validate_point_mappings
from .report import render_report
from .util import atomic_json, content_id, read_json, safe_child, sha256_file, utc_now


TERMINAL = {"needs_input", "succeeded", "failed"}


class JobStore:
    def __init__(self, artifact_root: Path):
        self.root = artifact_root.resolve()
        self.jobs = self.root / "jobs"

    def job_dir(self, job_id: str) -> Path:
        try:
            return safe_child(self.jobs, job_id)
        except ValueError as exc:
            raise QualityError("JOB_NOT_FOUND", "Invalid job ID.") from exc

    def read(self, job_id: str) -> dict[str, Any]:
        path = self.job_dir(job_id) / "status.json"
        if not path.exists():
            raise QualityError("JOB_NOT_FOUND", "Assessment job does not exist.", {"job_id": job_id})
        return read_json(path)

    def write(self, job_id: str, status: dict[str, Any]) -> None:
        status["updated_at"] = utc_now()
        atomic_json(self.job_dir(job_id) / "status.json", status)


def default_artifact_root() -> Path:
    return Path(__file__).resolve().parents[4] / ".skill-artifacts"


def _ensure_visualizations(status: dict[str, Any], artifact_root: Path) -> list[str]:
    if status.get("status") != "succeeded":
        return []
    bundle_id = status.get("quality_assessment_bundle_id")
    if not isinstance(bundle_id, str) or not bundle_id:
        return []
    try:
        from .visualization import publish_visualizations

        publish_visualizations(
            artifact_root / "quality-assessment-bundles" / bundle_id,
            artifact_root=artifact_root,
        )
    except Exception as exc:  # visualisation remains independent of cached business success
        return [f"VISUALIZATION_FAILED: {type(exc).__name__}: {exc}"]
    return []


def start_job(spec_path: Path, artifact_root: Path, launch_worker: bool = True) -> dict[str, Any]:
    try:
        spec = QualityAssessmentSpec.model_validate(read_json(spec_path))
    except (ValidationError, OSError, ValueError) as exc:
        raise QualityError("INVALID_ASSESSMENT_SPEC", "Assessment request is invalid.", {"error": str(exc)}) from exc
    identity = spec.model_dump(mode="json")
    job_id = content_id("dqjob", identity)
    store = JobStore(artifact_root)
    job_dir = store.job_dir(job_id)
    status_path = job_dir / "status.json"
    if status_path.exists():
        status = store.read(job_id)
        warnings = _ensure_visualizations(status, artifact_root)
        if warnings:
            return {**status, "warnings": [*status.get("warnings", []), *warnings]}
        return status
    job_dir.mkdir(parents=True, exist_ok=True)
    atomic_json(job_dir / "spec.json", identity)
    status = {"job_id": job_id, "status": "queued", "progress": 0, "current_stage": "queued", "warnings": [], "created_at": utc_now()}
    store.write(job_id, status)
    if launch_worker:
        command = [
            sys.executable, str(Path(__file__).resolve().parents[1] / "data_quality_cli.py"),
            "_worker", "--job-id", job_id, "--artifact-root", str(artifact_root),
        ]
        with open(os.devnull, "wb") as sink:
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sink, stderr=sink, start_new_session=True)
    return status


def _load_profile(artifact_root: Path, profile_id: str) -> QualityProfile:
    path = safe_child(artifact_root, "quality-profiles", profile_id, "quality_profile.json")
    if not path.exists():
        raise QualityError("PROFILE_NOT_FOUND", "QualityProfile does not exist.", {"quality_profile_id": profile_id})
    return QualityProfile.model_validate(read_json(path))


def _save_profile(artifact_root: Path, profile: QualityProfile) -> Path:
    profile = finalize_profile(profile)
    path = safe_child(artifact_root, "quality-profiles", profile.quality_profile_id or "", "quality_profile.json")
    if path.exists() and read_json(path) != profile.model_dump(mode="json"):
        raise QualityError("PROFILE_IMMUTABILITY_VIOLATION", "Existing Profile content differs from immutable ID.")
    atomic_json(path, profile.model_dump(mode="json"))
    return path


def _write_bundle(artifact_root: Path, result: Any, profile: QualityProfile) -> str:
    bundle_id = content_id("qabundle", {"assessment_id": result.assessment_id, "profile": profile.quality_profile_id})
    root = safe_child(artifact_root, "quality-assessment-bundles", bundle_id)
    root.mkdir(parents=True, exist_ok=True)
    atomic_json(root / "quality_result.json", result.model_dump(mode="json"))
    atomic_json(root / "quality_profile.json", profile.model_dump(mode="json"))
    (root / "quality_report.md").write_text(render_report(result, profile), encoding="utf-8")
    files = {
        name: sha256_file(root / name)
        for name in ["quality_result.json", "quality_profile.json", "quality_report.md"]
    }
    manifest = QualityAssessmentBundleManifest(
        quality_assessment_bundle_id=bundle_id,
        assessment_id=result.assessment_id,
        source_bundle_id=result.source_bundle_id,
        formula_version=result.formula_version,
        quality_profile_id=result.quality_profile_id,
        created_at=utc_now(),
        files=files,
    )
    atomic_json(root / "manifest.json", manifest.model_dump(mode="json"))
    return bundle_id


def run_worker(job_id: str, artifact_root: Path) -> None:
    store = JobStore(artifact_root)
    status = store.read(job_id)
    if status["status"] in {"succeeded", "needs_input"}:
        return
    try:
        status.update(status="running", progress=10, current_stage="validating_input")
        store.write(job_id, status)
        spec = QualityAssessmentSpec.model_validate(read_json(store.job_dir(job_id) / "spec.json"))
        bundle = load_dataset_bundle(artifact_root, spec.source_bundle_id)
        if spec.quality_profile_id:
            profile = ensure_compatible(_load_profile(artifact_root, spec.quality_profile_id), bundle.manifest.schema_fingerprint, spec.assessment_context)
            unresolved: list[dict[str, Any]] = []
        else:
            profile, unresolved = build_mvp_profile(
                bundle.manifest.schema_fingerprint,
                spec.assessment_context,
                bundle.points,
                bundle.parse_report,
            )
        target_rule = next((rule for rule in profile.variables if rule.role == "target"), None)
        if target_rule is not None and target_rule.unit is None:
            status.setdefault("warnings", []).append(
                "目标点位单位缺失；值域结论需要领域规则。"
            )
        if unresolved:
            atomic_json(store.job_dir(job_id) / "candidate_profile.json", profile.model_dump(mode="json"))
            status.update(
                status="needs_input", progress=25, current_stage="profile_confirmation",
                required_inputs=unresolved, candidate_profile=str(store.job_dir(job_id) / "candidate_profile.json"),
            )
            store.write(job_id, status)
            return
        validate_point_mappings(profile, bundle.points)
        _save_profile(artifact_root, profile)
        status.update(progress=35, current_stage="assessing_dimensions", quality_profile_id=profile.quality_profile_id)
        store.write(job_id, status)
        result = assess(bundle, profile)
        bundle_id = _write_bundle(artifact_root, result, profile)
        try:
            from .visualization import publish_visualizations

            publish_visualizations(
                artifact_root / "quality-assessment-bundles" / bundle_id,
                artifact_root=artifact_root,
            )
        except Exception as exc:  # visualisation must not change DQ success
            status.setdefault("warnings", []).append(
                f"VISUALIZATION_FAILED: {type(exc).__name__}: {exc}"
            )
        status.update(status="succeeded", progress=100, current_stage="completed", quality_assessment_bundle_id=bundle_id, assessment_id=result.assessment_id)
        store.write(job_id, status)
    except QualityError as exc:
        status.update(status="failed", progress=status.get("progress", 0), current_stage="failed", error=exc.as_dict())
        store.write(job_id, status)
    except Exception as exc:  # defensive task boundary
        status.update(
            status="failed", current_stage="failed",
            error={"code": "INTERNAL_ERROR", "message": str(exc), "details": {"traceback": traceback.format_exc()}},
        )
        store.write(job_id, status)


def resume_job(job_id: str, profile_path: Path, artifact_root: Path, launch_worker: bool = True) -> dict[str, Any]:
    store = JobStore(artifact_root)
    status = store.read(job_id)
    if status["status"] == "succeeded":
        return status
    if status["status"] != "needs_input":
        raise QualityError("JOB_NOT_RESUMABLE", "Only a needs_input job can be resumed.", {"status": status["status"]})
    try:
        profile = finalize_profile(QualityProfile.model_validate(read_json(profile_path)))
    except Exception as exc:
        raise QualityError("INVALID_QUALITY_PROFILE", "Confirmed QualityProfile is invalid.", {"error": str(exc)}) from exc
    spec = QualityAssessmentSpec.model_validate(read_json(store.job_dir(job_id) / "spec.json"))
    bundle = load_dataset_bundle(artifact_root, spec.source_bundle_id)
    profile = ensure_compatible(profile, bundle.manifest.schema_fingerprint, spec.assessment_context)
    validate_point_mappings(profile, bundle.points)
    _save_profile(artifact_root, profile)
    updated_spec = spec.model_copy(update={"quality_profile_id": profile.quality_profile_id})
    atomic_json(store.job_dir(job_id) / "spec.json", updated_spec.model_dump(mode="json"))
    for key in ["required_inputs", "candidate_profile", "error"]:
        status.pop(key, None)
    status.update(status="queued", progress=25, current_stage="resumed", quality_profile_id=profile.quality_profile_id)
    store.write(job_id, status)
    if launch_worker:
        command = [
            sys.executable, str(Path(__file__).resolve().parents[1] / "data_quality_cli.py"),
            "_worker", "--job-id", job_id, "--artifact-root", str(artifact_root),
        ]
        with open(os.devnull, "wb") as sink:
            subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=sink, stderr=sink, start_new_session=True)
    return status


def result_for(job_id: str, artifact_root: Path) -> dict[str, Any]:
    status = JobStore(artifact_root).read(job_id)
    if status["status"] != "succeeded":
        raise QualityError("RESULT_NOT_READY", "Assessment result is not ready.", {"status": status["status"]})
    bundle_id = status["quality_assessment_bundle_id"]
    root = safe_child(artifact_root, "quality-assessment-bundles", bundle_id)
    return {
        "job_id": job_id,
        "quality_assessment_bundle_id": bundle_id,
        "manifest": str(root / "manifest.json"),
        "quality_result": str(root / "quality_result.json"),
        "quality_profile": str(root / "quality_profile.json"),
        "quality_report": str(root / "quality_report.md"),
    }
