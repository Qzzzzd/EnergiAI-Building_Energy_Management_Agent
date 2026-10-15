"""Lifecycle adapter for persisted load-forecasting jobs."""

from __future__ import annotations

import json
import os
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable


SCRIPTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_ROOT))

from load_forecasting.jobs import get_result, get_status, run_job, start_job
from public_artifact import (
    PublicFile,
    discover_visualization_pngs,
    processing_source_ids,
    public_artifact_id,
    publish_public_artifact,
    read_json_object,
)
from public_views import evaluation_summary, forecast_preview, forecast_summary


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
    os.replace(temporary, path)


def _action(request: dict[str, Any]) -> str:
    explicit = request.get("action")
    if explicit in {"train_evaluate", "predict"}:
        return explicit
    mode = (request.get("forecast_spec") or {}).get("mode", "backtest")
    return "predict" if mode == "future" else "train_evaluate"


def _native_bundle_id(
    artifact_root: Path,
    supplied_id: str,
    collection: str,
    manifest_key: str,
) -> str:
    direct_manifest = artifact_root / collection / supplied_id / "manifest.json"
    if direct_manifest.is_file():
        return supplied_id
    public_manifest = artifact_root / "public-artifacts" / supplied_id / "native-manifest.json"
    if not public_manifest.is_file():
        return supplied_id
    try:
        payload = read_json_object(public_manifest)
    except (OSError, ValueError):
        return supplied_id
    native_id = payload.get(manifest_key)
    return native_id if isinstance(native_id, str) and native_id else supplied_id


def execute(
    *,
    request: dict[str, Any],
    answers: dict[str, Any] | None,
    job_dir: Path,
    workspace_root: Path,
    artifact_root: Path,
    progress: Callable[[str, int, int, list[str] | None], None],
) -> dict[str, Any]:
    if answers is not None:
        return {
            "status": "failed",
            "error": {"code": "JOB_NOT_RESUMABLE", "message": "Forecast jobs do not pause for user input"},
        }
    effective = deepcopy(request)
    action = _action(effective)
    effective.pop("action", None)
    for key, collection, manifest_key in (
        ("processing_bundle_id", "processing-bundles", "processing_bundle_id"),
        ("model_bundle_id", "model-bundles", "model_bundle_id"),
    ):
        supplied_id = effective.get(key)
        if isinstance(supplied_id, str):
            effective[key] = _native_bundle_id(artifact_root, supplied_id, collection, manifest_key)
    state_path = job_dir / "adapter_state.json"
    if state_path.is_file():
        internal_job_id = json.loads(state_path.read_text(encoding="utf-8"))["internal_job_id"]
    else:
        started = start_job(
            action,
            effective,
            artifact_root,
            SCRIPTS_ROOT / "load_forecasting_cli.py",
            launch_worker=False,
        )
        internal_job_id = started["job_id"]
        _atomic_json(state_path, {"internal_job_id": internal_job_id})
    current = get_status(artifact_root, internal_job_id)
    if current["status"] not in {"succeeded", "failed"}:
        progress("forecasting", int(current.get("progress", 0)), 100, current.get("warnings", []))
        run_job(artifact_root, internal_job_id)
        current = get_status(artifact_root, internal_job_id)
    result = get_result(artifact_root, internal_job_id)
    if current["status"] != "succeeded":
        return {
            "status": "failed",
            "error": result.get("error", current.get("error", {"code": "FORECAST_FAILED", "message": "Forecast job failed"})),
            "warnings": current.get("warnings", []),
        }
    artifact_refs: list[dict[str, str]] = []
    public_warnings = list(current.get("warnings", []))
    for key, artifact_type, collection in (
        ("model_bundle_id", "ModelBundle", "model-bundles"),
        ("evaluation_bundle_id", "EvaluationBundle", "evaluation-bundles"),
        ("forecast_bundle_id", "ForecastBundle", "forecast-bundles"),
    ):
        bundle_id = result.get(key)
        if not isinstance(bundle_id, str):
            continue
        manifest = artifact_root / collection / bundle_id / "manifest.json"
        if not manifest.is_file():
            return {
                "status": "failed",
                "error": {"code": "FORECAST_ARTIFACT_INVALID", "message": f"{artifact_type} manifest is missing"},
            }
        root = manifest.parent
        native_manifest = read_json_object(manifest)
        processing_bundle_id = native_manifest.get("processing_bundle_id")
        if not isinstance(processing_bundle_id, str):
            return {
                "status": "failed",
                "error": {"code": "FORECAST_ARTIFACT_INVALID", "message": f"{artifact_type} does not identify its ProcessingBundle"},
            }
        if artifact_type == "ModelBundle":
            summary = read_json_object(root / "training_summary.json")
            extra_files: list[PublicFile] = [
                PublicFile(root / "training_summary.json", "training-summary.json", "application/json; charset=utf-8", "summary-detail")
            ]
            json_files = None
            preview_complete = True
            preview_warnings: list[str] = []
        elif artifact_type == "EvaluationBundle":
            summary = evaluation_summary(root, artifact_root)
            extra_files = [
                PublicFile(root / "metrics.json", "metrics.json", "application/json; charset=utf-8", "metrics"),
                PublicFile(root / "evaluation_report.md", "evaluation-report.md", "text/markdown; charset=utf-8", "report"),
            ]
            json_files = None
            preview_complete = True
            preview_warnings = []
        else:
            summary = forecast_summary(root, artifact_root)
            extra_files = [
                PublicFile(root / "forecast_report.md", "forecast-report.md", "text/markdown; charset=utf-8", "report")
            ]
            try:
                preview = forecast_preview(root, artifact_root)
                json_files = {"forecast-preview.json": (preview, "forecast-preview")}
                preview_complete = True
                preview_warnings = []
            except (OSError, ValueError) as exc:
                json_files = None
                preview_complete = False
                preview_warnings = [f"FORECAST_PREVIEW_MISSING: {exc}"]

        visualization_files, visualization_warnings, visualization_complete = discover_visualization_pngs(
            artifact_root,
            source_type=artifact_type,
            source_id=bundle_id,
        )
        artifact_warnings = [*public_warnings, *preview_warnings, *visualization_warnings]
        artifact_ref = publish_public_artifact(
            artifact_root=artifact_root,
            artifact_id=public_artifact_id(SCRIPTS_ROOT.parent.name, job_dir.name, bundle_id),
            artifact_type=artifact_type,
            skill_name=SCRIPTS_ROOT.parent.name,
            job_id=job_dir.name,
            source_ids=processing_source_ids(artifact_root, processing_bundle_id),
            status="succeeded" if visualization_complete and preview_complete else "partial",
            summary=summary,
            warnings=artifact_warnings,
            source_files=[
                PublicFile(manifest, "native-manifest.json", "application/json; charset=utf-8", "native-manifest"),
                *extra_files,
                *visualization_files,
            ],
            json_files=json_files,
        )
        artifact_refs.append(artifact_ref)
        public_warnings.extend(warning for warning in artifact_warnings if warning not in public_warnings)
    progress("validating_forecast_artifacts", 100, 100, public_warnings)
    return {
        "status": "partial" if any(reference["status"] == "partial" for reference in artifact_refs) else "succeeded",
        **{key: value for key, value in result.items() if key not in {"job_id", "status"}},
        "artifact_refs": artifact_refs,
        "warnings": public_warnings,
    }
