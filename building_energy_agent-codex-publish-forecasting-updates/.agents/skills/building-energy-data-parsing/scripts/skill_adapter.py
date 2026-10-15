"""Lifecycle adapter for deterministic DatasetBundle parsing."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Callable

import pyarrow.dataset as ds
import pyarrow.parquet as pq

SCRIPTS_ROOT = Path(__file__).resolve().parent
SKILL_ROOT = SCRIPTS_ROOT.parent
sys.path.insert(0, str(SCRIPTS_ROOT))
sys.path.insert(0, str(SKILL_ROOT / "src"))

from building_energy_agent.contracts.skill1_v07 import ParseRequest, SourceReference
from building_energy_agent.core.artifact_store import dataset_bundle_root
from building_energy_agent.core.errors import SkillNeedsInputError
from building_energy_agent.skills.skill1_parse.service import Skill1ParseService
from building_energy_agent.skills.skill1_parse.sources import LocalSourceRegistry, sha256_file
from building_energy_agent.skills.skill1_parse.validation import validate_dataset_bundle
from public_artifact import PublicFile, discover_visualization_pngs, public_artifact_id, publish_public_artifact


OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _format_granularity(intervals: list[int]) -> str | None:
    values = sorted({value for value in intervals if value > 0})
    if not values:
        return None
    formatted: list[str] = []
    for seconds in values:
        if seconds % 3600 == 0:
            formatted.append(f"{seconds // 3600}h")
        elif seconds % 60 == 0:
            formatted.append(f"{seconds // 60}min")
        else:
            formatted.append(f"{seconds}s")
    return "/".join(formatted)


def _point_catalog(bundle_path: Path) -> list[dict[str, Any]]:
    points = pq.read_table(
        bundle_path / "points.parquet",
        columns=[
            "point_id",
            "name",
            "description",
            "unit",
            "variable_type",
            "expected_interval_seconds",
        ],
    ).to_pylist()
    parse_report = json.loads((bundle_path / "parse_report.json").read_text(encoding="utf-8"))
    lineage: dict[str, dict[str, str]] = {}
    for worksheet in parse_report.get("worksheets", []):
        if worksheet.get("status") != "succeeded":
            continue
        for column in worksheet.get("columns", []):
            point_id = column.get("point_id")
            if isinstance(point_id, str) and point_id not in lineage:
                lineage[point_id] = {
                    "worksheet_name": str(worksheet.get("worksheet_name") or ""),
                    "original_column_name": str(column.get("original_column_name") or point_id),
                }

    observation_counts: Counter[str] = Counter()
    non_null_counts: Counter[str] = Counter()
    timeseries_root = bundle_path / "data" / "timeseries"
    if timeseries_root.is_dir():
        dataset = ds.dataset(timeseries_root, format="parquet", partitioning="hive")
        for batch in dataset.scanner(columns=["point_id", "value_raw"]).to_batches():
            for point_id, value in zip(
                batch.column("point_id").to_pylist(),
                batch.column("value_raw").to_pylist(),
                strict=False,
            ):
                if isinstance(point_id, str):
                    observation_counts[point_id] += 1
                    if value is not None:
                        non_null_counts[point_id] += 1

    catalog: list[dict[str, Any]] = []
    for point in sorted(points, key=lambda item: str(item.get("point_id") or "")):
        point_id = str(point.get("point_id") or "")
        observed = observation_counts.get(point_id, 0)
        non_null = non_null_counts.get(point_id, 0)
        lineage_item = lineage.get(point_id, {})
        catalog.append(
            {
                "point_id": point_id,
                "original_column_name": lineage_item.get("original_column_name", point_id),
                "worksheet_name": lineage_item.get("worksheet_name", ""),
                "name": str(point.get("name") or ""),
                "description": str(point.get("description") or ""),
                "unit": point.get("unit"),
                "variable_type": point.get("variable_type"),
                "expected_interval_seconds": point.get("expected_interval_seconds"),
                "observation_count": observed,
                "non_null_count": non_null,
                "missing_rate": round((observed - non_null) / observed, 6) if observed else None,
            }
        )
    return catalog


def _public_summary(result: Any, bundle_path: Path) -> dict[str, Any]:
    summary = result.summary.model_dump(mode="json")
    points = pq.read_table(
        bundle_path / "points.parquet", columns=["expected_interval_seconds"]
    )
    intervals = [
        int(value)
        for value in points.column("expected_interval_seconds").to_pylist()
        if value is not None
    ]
    granularity = _format_granularity(intervals)
    if granularity is not None:
        summary["data_granularity"] = granularity
    summary["point_catalog"] = _point_catalog(bundle_path)
    return summary


def _safe_source(workspace_root: Path, relative_path: str) -> Path:
    supplied = Path(relative_path)
    if supplied.is_absolute():
        raise ValueError("source relative_path must stay inside the controlled session roots")
    resolved = (workspace_root / supplied).resolve(strict=True)
    controlled_roots = [workspace_root]
    input_root = workspace_root.parent / "inputs"
    if input_root.is_dir():
        controlled_roots.append(input_root.resolve(strict=True))
    if not any(_is_relative_to(resolved, root) for root in controlled_roots):
        raise ValueError("source relative_path escapes the controlled session roots")
    if not resolved.is_file():
        raise ValueError("source reference is not a regular file")
    return resolved


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _merged_hints(request: dict[str, Any], answers: dict[str, Any] | None) -> dict[str, Any]:
    hints = dict(request.get("parse_hints") or {})
    if answers:
        if isinstance(answers.get("parse_hints"), dict):
            hints.update(answers["parse_hints"])
        if isinstance(answers.get("source_timezone"), str):
            hints["source_timezone"] = answers["source_timezone"]
    return hints


def execute(
    *,
    request: dict[str, Any],
    answers: dict[str, Any] | None,
    job_dir: Path,
    workspace_root: Path,
    artifact_root: Path,
    progress: Callable[[str, int, int, list[str] | None], None],
) -> dict[str, Any]:
    sources = request.get("sources")
    if not isinstance(sources, list) or not sources:
        return {
            "status": "failed",
            "error": {"code": "INVALID_PARSE_REQUEST", "message": "sources must be a non-empty array"},
        }
    registry = LocalSourceRegistry()
    references: list[SourceReference] = []
    public_source_ids: list[str] = []
    progress("validating_sources", 0, len(sources), None)
    for index, source in enumerate(sources, 1):
        if not isinstance(source, dict) or not isinstance(source.get("relative_path"), str):
            return {
                "status": "failed",
                "error": {"code": "INVALID_SOURCE_REFERENCE", "message": "Each source requires relative_path"},
            }
        path = _safe_source(workspace_root, source["relative_path"])
        expected_hash = source.get("sha256")
        if isinstance(expected_hash, str) and sha256_file(path) != expected_hash.casefold():
            return {
                "status": "failed",
                "error": {"code": "SOURCE_HASH_MISMATCH", "message": f"Source snapshot hash mismatch at item {index}"},
            }
        registered = registry.register(path)
        expected_ref = source.get("source_ref")
        if isinstance(expected_ref, str):
            if not OPAQUE_ID.fullmatch(expected_ref):
                return {
                    "status": "failed",
                    "error": {"code": "INVALID_SOURCE_REFERENCE", "message": f"Source reference is invalid at item {index}"},
                }
            if expected_ref.startswith("local-sha256:") and expected_ref != registered.source_ref:
                return {
                    "status": "failed",
                    "error": {"code": "SOURCE_REF_MISMATCH", "message": f"Source reference mismatch at item {index}"},
                }
            if expected_ref != registered.source_ref and not isinstance(expected_hash, str):
                return {
                    "status": "failed",
                    "error": {"code": "SOURCE_HASH_REQUIRED", "message": f"Server source references require sha256 at item {index}"},
                }
            public_source_ids.append(expected_ref)
        else:
            public_source_ids.append(registered.source_ref)
        references.append(SourceReference(source_ref=registered.source_ref))
        progress("validating_sources", index, len(sources), None)

    parse_request = ParseRequest(
        sources=references,
        parse_hints=_merged_hints(request, answers),
        strict_mode=bool(request.get("strict_mode", False)),
    )
    progress("parsing", 0, 1, None)
    service = Skill1ParseService(registry, artifact_root)
    started = service.start(parse_request)
    status = service.status(started.job_id)
    if status.status == "needs_input":
        return {
            "status": "needs_input",
            "required_inputs": [
                {
                    "id": "source_timezone",
                    "question": "源时间戳没有明确时区，请提供 IANA 时区。",
                    "options": ["Asia/Shanghai", "UTC"],
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
                "code": "PARSE_FAILED",
                "message": status.warnings[0] if status.warnings else "Dataset parsing failed",
            },
            "warnings": status.warnings,
        }
    result = service.result(started.job_id)
    bundle_path = dataset_bundle_root(artifact_root, result.dataset_bundle_id)
    validate_dataset_bundle(bundle_path)
    public_summary = _public_summary(result, bundle_path)
    manifest_path = bundle_path / "manifest.json"
    visualization_files, visualization_warnings, visualization_complete = discover_visualization_pngs(
        artifact_root,
        source_type="DatasetBundle",
        source_id=result.dataset_bundle_id,
    )
    warnings = [*status.warnings, *visualization_warnings]
    public_status = "succeeded" if visualization_complete else "partial"
    artifact_ref = publish_public_artifact(
        artifact_root=artifact_root,
        artifact_id=public_artifact_id(SKILL_ROOT.name, job_dir.name, result.dataset_bundle_id),
        artifact_type="DatasetBundle",
        skill_name=SKILL_ROOT.name,
        job_id=job_dir.name,
        source_ids=public_source_ids,
        status=public_status,
        summary=public_summary,
        warnings=warnings,
        source_files=[
            PublicFile(manifest_path, "native-manifest.json", "application/json; charset=utf-8", "native-manifest"),
            PublicFile(bundle_path / "parse_report.json", "parse-report.json", "application/json; charset=utf-8", "report"),
            *visualization_files,
        ],
    )
    progress("validating_bundle", 1, 1, status.warnings)
    return {
        "status": artifact_ref["status"],
        "dataset_bundle_id": result.dataset_bundle_id,
        "summary": public_summary,
        "artifact_refs": [artifact_ref],
        "warnings": warnings,
    }
