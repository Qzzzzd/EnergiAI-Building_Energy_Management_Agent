"""Lifecycle adapter for resumable, read-only data quality assessment."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable


SCRIPTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_ROOT))

_DISPLAY_POINT_ID = re.compile(r"[（(]([^（）()]*\|[^（）()]*)[）)]")

from data_quality_assessment.jobs import JobStore, result_for, resume_job, run_worker, start_job
from public_artifact import (
    PublicFile,
    dataset_source_ids,
    discover_visualization_pngs,
    public_artifact_id,
    publish_public_artifact,
)
from public_views import quality_summary


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def _native_bundle_id(artifact_root: Path, supplied_id: str) -> str:
    direct = artifact_root / "dataset-bundles" / supplied_id / "manifest.json"
    if direct.is_file():
        return supplied_id
    public_manifest = artifact_root / "public-artifacts" / supplied_id / "native-manifest.json"
    if public_manifest.is_file():
        try:
            payload = json.loads(public_manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return supplied_id
        native_id = payload.get("dataset_bundle_id")
        if isinstance(native_id, str) and native_id:
            return native_id
    return supplied_id


def _normalize_target_point_id(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    match = _DISPLAY_POINT_ID.search(value)
    return match.group(1).strip() if match else value.strip()


def execute(
    *,
    request: dict[str, Any],
    answers: dict[str, Any] | None,
    job_dir: Path,
    workspace_root: Path,
    artifact_root: Path,
    progress: Callable[[str, int, int, list[str] | None], None],
) -> dict[str, Any]:
    effective_request = dict(request)
    source_bundle_id = effective_request.get("source_bundle_id")
    if isinstance(source_bundle_id, str) and source_bundle_id:
        effective_request["source_bundle_id"] = _native_bundle_id(artifact_root, source_bundle_id)
    context = effective_request.get("assessment_context")
    if isinstance(context, dict) and "target_point_id" in context:
        effective_context = dict(context)
        effective_context["target_point_id"] = _normalize_target_point_id(
            effective_context["target_point_id"]
        )
        effective_request["assessment_context"] = effective_context
    state_path = job_dir / "adapter_state.json"
    if state_path.is_file():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        internal_job_id = state["internal_job_id"]
    else:
        normalized_request_path = job_dir / ".normalized-request.json"
        _atomic_json(normalized_request_path, effective_request)
        started = start_job(normalized_request_path, artifact_root, launch_worker=False)
        internal_job_id = started["job_id"]
        _atomic_json(state_path, {"internal_job_id": internal_job_id})

    if answers is not None:
        profile = answers.get("quality_profile") or answers.get("profile") or answers
        if not isinstance(profile, dict):
            return {
                "status": "failed",
                "error": {"code": "INVALID_QUALITY_PROFILE", "message": "resume answers must contain a QualityProfile object"},
            }
        profile_path = job_dir / "confirmed_profile.json"
        _atomic_json(profile_path, profile)
        resume_job(internal_job_id, profile_path, artifact_root, launch_worker=False)

    current = JobStore(artifact_root).read(internal_job_id)
    if current["status"] not in {"needs_input", "succeeded", "failed"}:
        progress("assessing_quality", int(current.get("progress", 0)), 100, current.get("warnings", []))
        run_worker(internal_job_id, artifact_root)
        current = JobStore(artifact_root).read(internal_job_id)
    if current["status"] == "needs_input":
        candidate_path = JobStore(artifact_root).job_dir(internal_job_id) / "candidate_profile.json"
        candidate = json.loads(candidate_path.read_text(encoding="utf-8")) if candidate_path.is_file() else None
        return {
            "status": "needs_input",
            "required_inputs": current.get("required_inputs", []),
            "candidate_profile": candidate,
            "warnings": current.get("warnings", []),
        }
    if current["status"] != "succeeded":
        return {
            "status": "failed",
            "error": current.get("error", {"code": "QUALITY_ASSESSMENT_FAILED", "message": "Assessment failed"}),
            "warnings": current.get("warnings", []),
        }
    result = result_for(internal_job_id, artifact_root)
    bundle_id = result["quality_assessment_bundle_id"]
    root = artifact_root / "quality-assessment-bundles" / bundle_id
    manifest = root / "manifest.json"
    public_summary = quality_summary(root)
    visualization_files, visualization_warnings, visualization_complete = discover_visualization_pngs(
        artifact_root,
        source_type="QualityAssessmentBundle",
        source_id=bundle_id,
    )
    warnings = [*current.get("warnings", []), *visualization_warnings]
    artifact_ref = publish_public_artifact(
        artifact_root=artifact_root,
        artifact_id=public_artifact_id(Path(__file__).resolve().parents[1].name, job_dir.name, bundle_id),
        artifact_type="QualityAssessmentBundle",
        skill_name=Path(__file__).resolve().parents[1].name,
        job_id=job_dir.name,
        source_ids=dataset_source_ids(artifact_root, effective_request["source_bundle_id"]),
        status="succeeded" if visualization_complete else "partial",
        summary=public_summary,
        warnings=warnings,
        source_files=[
            PublicFile(manifest, "native-manifest.json", "application/json; charset=utf-8", "native-manifest"),
            PublicFile(root / "quality_report.md", "quality-report.md", "text/markdown; charset=utf-8", "report"),
            *visualization_files,
        ],
    )
    progress("validating_quality_bundle", 100, 100, warnings)
    return {
        "status": artifact_ref["status"],
        "quality_assessment_bundle_id": bundle_id,
        "assessment_id": current.get("assessment_id"),
        "summary": public_summary,
        "artifact_refs": [artifact_ref],
        "warnings": warnings,
    }
