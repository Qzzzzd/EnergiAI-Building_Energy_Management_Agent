"""Lifecycle adapter for the deterministic building-energy report Skill."""

from __future__ import annotations

import json
import os
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable

SCRIPTS_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_ROOT))

from report_generation.core import ReportFailure, generate_report


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _effective_request(request: dict[str, Any], answers: dict[str, Any] | None) -> dict[str, Any]:
    effective = deepcopy(request)
    source_ids = effective.setdefault("source_artifact_ids", {})
    if not isinstance(source_ids, dict):
        source_ids = {}
        effective["source_artifact_ids"] = source_ids
    legacy_sources = {
        "quality_assessment_bundle_id": "quality",
        "processing_bundle_id": "processing",
        "evaluation_bundle_id": "evaluation",
        "forecast_bundle_id": "forecast",
    }
    for legacy_key, source_key in legacy_sources.items():
        value = effective.pop(legacy_key, None)
        if isinstance(value, str) and value and source_key not in source_ids:
            source_ids[source_key] = value
    if not answers:
        return effective
    if isinstance(answers.get("report_request"), dict):
        effective.update(deepcopy(answers["report_request"]))
    if isinstance(answers.get("source_artifact_ids"), dict):
        ids = effective.setdefault("source_artifact_ids", {})
        if isinstance(ids, dict):
            ids.update(deepcopy(answers["source_artifact_ids"]))
    for key in ("quality", "processing", "evaluation", "forecast"):
        value = answers.get(key)
        if isinstance(value, str) and value:
            effective.setdefault("source_artifact_ids", {})[key] = value
    return effective


def execute(
    *,
    request: dict[str, Any],
    answers: dict[str, Any] | None,
    job_dir: Path,
    workspace_root: Path,
    artifact_root: Path,
    progress: Callable[[str, int, int, list[str] | None], None],
) -> dict[str, Any]:
    effective = _effective_request(request, answers)
    _atomic_json(job_dir / "effective-request.json", effective)
    try:
        return generate_report(
            effective,
            artifact_root=artifact_root,
            job_id=job_dir.name,
            progress=progress,
        )
    except ReportFailure as exc:
        return {
            "status": "failed",
            "error": {"code": exc.code, "message": str(exc), "details": exc.details},
        }
