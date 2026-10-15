"""Lifecycle adapter for the leakage-safe ProcessingBundle pipeline."""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable


SCRIPTS_ROOT = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPTS_ROOT.parent
sys.path.insert(0, str(SCRIPTS_ROOT))
sys.path.insert(0, str(SKILL_ROOT / "src"))

from pydantic import ValidationError

from building_energy_agent.contracts.skill2_v07 import ProcessingSpec
from building_energy_agent.core.artifact_store import processing_bundle_root
from building_energy_agent.skills.skill2_processing.preflight import (
    DatasetBundleReader,
    TargetCandidate,
)
from building_energy_agent.skills.skill2_processing.service import Skill2ProcessingService
from public_artifact import (
    PublicFile,
    discover_visualization_pngs,
    processing_source_ids,
    public_artifact_id,
    publish_public_artifact,
)


def _merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _answer_overlay(answers: dict[str, Any] | None) -> dict[str, Any]:
    overlay = deepcopy(answers or {})
    point_id = overlay.pop("target_point_id", None)
    if isinstance(point_id, str) and point_id.strip():
        target = overlay.get("target")
        if not isinstance(target, dict):
            target = {}
            overlay["target"] = target
        target.setdefault("point_id", point_id.strip())
    return overlay


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


def _forecast_target_candidates(bundle_path: Path) -> list[TargetCandidate]:
    reader = DatasetBundleReader(bundle_path)
    candidates: dict[str, TargetCandidate] = {}
    for worksheet in reader.worksheets:
        if worksheet.get("status") != "succeeded":
            continue
        worksheet_name = str(worksheet.get("worksheet_name") or "")
        source_partition = worksheet.get("output_partition")
        if not isinstance(source_partition, str):
            continue
        for column in worksheet.get("columns", []):
            if not isinstance(column, dict):
                continue
            point_id = column.get("point_id")
            point = reader.points.get(str(point_id))
            if point is None or point.variable_type != "continuous":
                continue
            candidates[str(point_id)] = TargetCandidate(
                point_id=str(point_id),
                worksheet_name=worksheet_name,
                source_partition=source_partition,
                original_column_name=str(column.get("original_column_name") or ""),
                name=point.name,
                description=point.description,
                unit=point.unit,
            )
    return sorted(
        candidates.values(),
        key=lambda candidate: (
            candidate.description or candidate.name or candidate.point_id,
            candidate.point_id,
        ),
    )


def _normalize_target_value(value: Any, candidates: list[TargetCandidate]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    for candidate in candidates:
        display_name = candidate.original_column_name or candidate.name or candidate.description or candidate.point_id
        label = f"{display_name}（{candidate.point_id}）"
        if raw in {
            candidate.point_id,
            candidate.original_column_name,
            candidate.name,
            candidate.description,
            label,
        }:
            return candidate.point_id
    return raw


def _target_input(
    candidates: list[Any],
    needs_input_reason: str | None = None,
) -> dict[str, Any]:
    labels = [
        f"{candidate.original_column_name or candidate.name or candidate.description or candidate.point_id}（{candidate.point_id}）"
        for candidate in candidates
    ]
    return {
        "status": "needs_input",
        "required_inputs": [
            {
                "id": "target_point_id",
                "question": (
                    "请确认用于负荷预测的连续数值目标点位："
                    + "；".join(labels)
                    if labels
                    else "未能从 DatasetBundle 自动确定负荷预测目标，请输入 point_id。"
                ),
                "options": labels,
                "allow_free_text": True,
                "required": True,
            }
        ],
        "warnings": [
            needs_input_reason
            or "Processing target is required and must not be guessed."
        ],
    }


def execute(
    *,
    request: dict[str, Any],
    answers: dict[str, Any] | None,
    job_dir: Path,
    workspace_root: Path,
    artifact_root: Path,
    progress: Callable[[str, int, int, list[str] | None], None],
) -> dict[str, Any]:
    effective = _merge(request, _answer_overlay(answers))
    effective.setdefault("prediction_spec", {"forecast_horizon": "24h"})
    effective.setdefault("feature_spec", {"preset": "default"})
    effective.setdefault("data_scope", {"local_timezone": "Asia/Shanghai"})
    source_bundle_id = effective.get("source_bundle_id")
    source_manifest: Path | None = None
    if isinstance(source_bundle_id, str) and source_bundle_id:
        native_id = _native_bundle_id(artifact_root, source_bundle_id)
        effective["source_bundle_id"] = native_id
        source_manifest = artifact_root / "dataset-bundles" / native_id / "manifest.json"
        if not source_manifest.is_file():
            return {
                "status": "failed",
                "error": {
                    "code": "DATASET_BUNDLE_NOT_FOUND",
                    "message": "The referenced DatasetBundle is not present in the session artifact root.",
                },
            }
        target = effective.get("target")
        if not isinstance(target, dict) or not isinstance(target.get("point_id"), str) or not target["point_id"].strip():
            candidates = _forecast_target_candidates(source_manifest.parent)
            return _target_input(
                candidates,
                "需要先由调用方根据 DatasetBundle 点位目录确认目标点位。",
            )
        if isinstance(target, dict) and isinstance(target.get("point_id"), str):
            candidates = _forecast_target_candidates(source_manifest.parent)
            normalized = _normalize_target_value(target["point_id"], candidates)
            if normalized:
                effective["target"] = {"point_id": normalized}
    try:
        spec = ProcessingSpec.model_validate(effective)
    except ValidationError as exc:
        missing_target = any(tuple(error.get("loc", ()))[:1] == ("target",) for error in exc.errors())
        if missing_target:
            return _target_input([])
        return {
            "status": "failed",
            "error": {"code": "INVALID_PROCESSING_SPEC", "message": str(exc)},
        }

    progress("validating_dataset_bundle", 0, 3, None)
    source_manifest = artifact_root / "dataset-bundles" / spec.source_bundle_id / "manifest.json"
    if not source_manifest.is_file():
        return {
            "status": "failed",
            "error": {
                "code": "DATASET_BUNDLE_NOT_FOUND",
                "message": "The referenced DatasetBundle is not present in the session artifact root.",
            },
        }
    progress("building_leakage_safe_features", 1, 3, None)
    service = Skill2ProcessingService(artifact_root)
    started = service.start(spec)
    status = service.status(started.job_id)
    if status.status == "needs_input":
        return {
            "status": "needs_input",
            "required_inputs": [
                {
                    "id": "processing_spec",
                    "question": status.warnings[0] if status.warnings else "处理参数需要确认。",
                    "options": [],
                    "allow_free_text": True,
                    "required": True,
                }
            ],
            "warnings": status.warnings,
        }
    if status.status != "succeeded":
        return {
            "status": "failed",
            "error": {
                "code": "PROCESSING_FAILED",
                "message": status.warnings[0] if status.warnings else "Processing failed",
            },
            "warnings": status.warnings,
        }
    result = service.result(started.job_id)
    bundle_path = processing_bundle_root(artifact_root, result.processing_bundle_id)
    manifest_path = bundle_path / "manifest.json"
    if not manifest_path.is_file():
        return {
            "status": "failed",
            "error": {"code": "PROCESSING_BUNDLE_INVALID", "message": "ProcessingBundle manifest is missing"},
        }
    visualization_files, visualization_warnings, visualization_complete = discover_visualization_pngs(
        artifact_root,
        source_type="ProcessingBundle",
        source_id=result.processing_bundle_id,
    )
    warnings = [*status.warnings, *visualization_warnings]
    public_status = "succeeded" if visualization_complete else "partial"
    artifact_ref = publish_public_artifact(
        artifact_root=artifact_root,
        artifact_id=public_artifact_id(SKILL_ROOT.name, job_dir.name, result.processing_bundle_id),
        artifact_type="ProcessingBundle",
        skill_name=SKILL_ROOT.name,
        job_id=job_dir.name,
        source_ids=processing_source_ids(artifact_root, result.processing_bundle_id),
        status=public_status,
        summary=result.summary,
        warnings=warnings,
        source_files=[
            PublicFile(manifest_path, "native-manifest.json", "application/json; charset=utf-8", "native-manifest"),
            PublicFile(bundle_path / "processing_report.json", "processing-report.json", "application/json; charset=utf-8", "report"),
            *visualization_files,
        ],
    )
    progress("validating_processing_bundle", 3, 3, warnings)
    return {
        "status": artifact_ref["status"],
        "processing_bundle_id": result.processing_bundle_id,
        "summary": result.summary,
        "artifact_refs": [artifact_ref],
        "warnings": warnings,
    }
