"""Publish small, contract-safe files from native Skill bundles."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping


_OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SAFE_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_MAX_METADATA_BYTES = 2 * 1024 * 1024
_MAX_PNG_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class PublicFile:
    source: Path
    relative_name: str
    media_type: str
    role: str
    max_bytes: int = _MAX_METADATA_BYTES
    descriptor: Mapping[str, Any] | None = None


_VISUALIZATION_TITLES = {
    "dataset_overview": "数据集概览", "observations_by_point": "点位观测分布", "time_coverage_by_partition": "工作表时间覆盖", "target_timeseries_preview": "目标点位时序预览",
    "processed_target_timeline": "处理后目标曲线", "gap_and_segment_timeline": "缺口与分段", "split_timeline": "样本时间切分", "sample_exclusions": "样本排除原因", "split_sample_counts": "各阶段样本数量",
    "quality_score_overview": "六维质量评分", "quality_overall_score": "综合质量评分", "issue_severity_counts": "质量问题严重性分布", "issues_by_dimension": "质量问题按维度分布", "affected_scope_summary": "受影响范围摘要",
    "model_summary": "模型摘要", "metrics_overview": "模型评价指标", "actual_vs_prediction": "实际值与预测值对比", "actual_vs_prediction_scatter": "实际值与预测值散点", "residual_distribution": "残差分布", "feature_importance": "特征重要性", "training_history": "训练历史", "error_by_horizon": "按预测步长的误差", "forecast_timeseries": "未来负荷预测", "forecast_summary": "预测摘要", "forecast_by_horizon": "按预测步长的预测值", "forecast_threshold": "预测阈值超限",
}
_VISUALIZATION_CATEGORIES = {
    "dataset_overview": "overview", "observations_by_point": "overview", "time_coverage_by_partition": "overview", "target_timeseries_preview": "overview", "processed_target_timeline": "overview", "gap_and_segment_timeline": "data_quality", "split_timeline": "load_forecast", "sample_exclusions": "data_quality", "split_sample_counts": "load_forecast",
    "quality_score_overview": "data_quality", "quality_overall_score": "data_quality", "issue_severity_counts": "data_quality", "issues_by_dimension": "data_quality", "affected_scope_summary": "data_quality",
    "model_summary": "load_forecast", "metrics_overview": "load_forecast", "actual_vs_prediction": "load_forecast", "actual_vs_prediction_scatter": "load_forecast", "residual_distribution": "load_forecast", "feature_importance": "load_forecast", "training_history": "load_forecast", "error_by_horizon": "load_forecast", "forecast_timeseries": "load_forecast", "forecast_summary": "load_forecast", "forecast_by_horizon": "load_forecast", "forecast_threshold": "load_forecast",
}


def read_json_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, value: Mapping[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _json_size(value: Mapping[str, Any] | list[Any]) -> int:
    return len(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )


def _safe_relative(value: str) -> str:
    path = Path(value)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} or not _SAFE_SEGMENT.fullmatch(part)
        for part in path.parts
    ):
        raise ValueError("public artifact file name must be a controlled relative path")
    return path.as_posix()


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _source_file(source: Path, artifact_root: Path, maximum: int) -> Path:
    resolved = source.resolve(strict=True)
    if not _inside(resolved, artifact_root) or not resolved.is_file():
        raise ValueError("public source file must be a regular file inside the artifact root")
    size = resolved.stat().st_size
    if size > maximum:
        raise ValueError(f"public source file exceeds {maximum} bytes")
    return resolved


def _warnings(values: Iterable[Any]) -> list[str]:
    output: list[str] = []
    for value in values:
        text = str(value).strip()
        if text and text not in output:
            output.append(text[:2000])
    return output


def _source_ids(values: Iterable[Any]) -> list[str]:
    output: list[str] = []
    for value in values:
        if not isinstance(value, str) or not _OPAQUE_ID.fullmatch(value):
            continue
        if value not in output:
            output.append(value)
    return output


def public_artifact_id(skill_name: str, job_id: str, native_bundle_id: str) -> str:
    identity = f"{skill_name}\0{job_id}\0{native_bundle_id}".encode("utf-8")
    return f"artifact-{hashlib.sha256(identity).hexdigest()[:32]}"


def dataset_source_ids(artifact_root: Path, dataset_bundle_id: str) -> list[str]:
    public_root = artifact_root / "public-artifacts"
    if public_root.is_dir():
        for public_manifest in sorted(public_root.glob("*/manifest.json")):
            manifest = read_json_object(public_manifest)
            if manifest.get("artifact_type") != "DatasetBundle":
                continue
            files = manifest.get("files")
            if not isinstance(files, list):
                continue
            native_entry = next(
                (
                    item
                    for item in files
                    if isinstance(item, dict) and item.get("role") == "native-manifest"
                ),
                None,
            )
            if not isinstance(native_entry, dict) or not isinstance(native_entry.get("relative_path"), str):
                continue
            native_manifest = artifact_root / native_entry["relative_path"]
            if not native_manifest.is_file():
                continue
            if read_json_object(native_manifest).get("dataset_bundle_id") != dataset_bundle_id:
                continue
            source_ids = manifest.get("source_ids")
            if isinstance(source_ids, list):
                validated = _source_ids(source_ids)
                if validated:
                    return validated
    report_path = artifact_root / "dataset-bundles" / dataset_bundle_id / "parse_report.json"
    if not report_path.is_file():
        return []
    report = read_json_object(report_path)
    sources = report.get("sources")
    if not isinstance(sources, list):
        return []
    return _source_ids(
        source.get("source_ref")
        for source in sources
        if isinstance(source, dict)
    )


def processing_source_ids(artifact_root: Path, processing_bundle_id: str) -> list[str]:
    manifest_path = artifact_root / "processing-bundles" / processing_bundle_id / "manifest.json"
    if not manifest_path.is_file():
        return []
    dataset_bundle_id = read_json_object(manifest_path).get("source_bundle_id")
    if not isinstance(dataset_bundle_id, str):
        return []
    return dataset_source_ids(artifact_root, dataset_bundle_id)


def _visualization_descriptor(figure: Mapping[str, Any], chart_id: str, fallback_order: int, public_name: str) -> dict[str, Any]:
    declared_title = figure.get("title")
    declared_category = figure.get("business_category")
    declared_order = figure.get("display_order")
    descriptor: dict[str, Any] = {"chart_id": chart_id, "title": declared_title if isinstance(declared_title, str) and declared_title else _VISUALIZATION_TITLES.get(chart_id, chart_id), "display_order": declared_order if isinstance(declared_order, int) and not isinstance(declared_order, bool) and declared_order >= 0 else fallback_order, "file_name": public_name, "business_category": declared_category if isinstance(declared_category, str) and declared_category else _VISUALIZATION_CATEGORIES.get(chart_id, "overview")}
    description = figure.get("description")
    if isinstance(description, str) and description:
        descriptor["description"] = description
    return descriptor


def discover_visualization_pngs(
    artifact_root: Path,
    *,
    source_type: str,
    source_id: str,
) -> tuple[list[PublicFile], list[str], bool]:
    visualization_root = artifact_root / "visualization-bundles"
    matches: list[tuple[Path, dict[str, Any]]] = []
    if visualization_root.is_dir():
        for manifest_path in sorted(visualization_root.glob("*/manifest.json")):
            try:
                manifest = read_json_object(manifest_path)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            source = manifest.get("source")
            if (
                isinstance(source, dict)
                and source.get("bundle_type") == source_type
                and source.get("bundle_id") == source_id
            ):
                matches.append((manifest_path, manifest))
    if not matches:
        warning = f"DISPLAY_ARTIFACTS_MISSING: no visualization bundle for {source_type} {source_id}"
        return [], [warning], False

    manifest_path, manifest = matches[0]
    warnings: list[str] = []
    if len(matches) > 1:
        warnings.append("DISPLAY_ARTIFACTS_AMBIGUOUS: multiple visualization bundles matched; the first was used")
    file_hashes = manifest.get("file_hashes")
    figures = manifest.get("figures")
    if not isinstance(file_hashes, dict) or not isinstance(figures, list):
        return [], [*warnings, "DISPLAY_ARTIFACTS_INVALID: visualization manifest is incomplete"], False

    files: list[PublicFile] = []
    complete = manifest.get("status") == "succeeded"
    for fallback_order, figure in enumerate(figures):
        if not isinstance(figure, dict) or figure.get("status") != "available":
            continue
        relative = figure.get("relative_path")
        chart_id = figure.get("chart_id")
        if not isinstance(relative, str) or not isinstance(chart_id, str):
            complete = False
            warnings.append("DISPLAY_ARTIFACTS_INVALID: an available figure lacks identifiers")
            continue
        try:
            relative_path = _safe_relative(relative)
            source_path = _source_file(manifest_path.parent / relative_path, artifact_root, _MAX_PNG_BYTES)
            expected = file_hashes.get(relative_path)
            actual = sha256_file(source_path)
            if expected != actual or figure.get("sha256", actual) != actual:
                raise ValueError("figure hash does not match the visualization manifest")
            if not source_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n":
                raise ValueError("figure is not a PNG")
            files.append(
                PublicFile(
                    source=source_path,
                    relative_name=f"figures/{_safe_relative(chart_id)}.png",
                    media_type="image/png",
                    role="visualization",
                    max_bytes=_MAX_PNG_BYTES,
                    descriptor=_visualization_descriptor(figure, chart_id, fallback_order, f"figures/{_safe_relative(chart_id)}.png"),
                )
            )
        except (OSError, ValueError) as exc:
            complete = False
            warnings.append(f"DISPLAY_ARTIFACTS_INVALID: {chart_id}: {exc}")
    if not files:
        complete = False
        warnings.append(f"DISPLAY_ARTIFACTS_MISSING: no validated PNG for {source_type} {source_id}")
    return files, _warnings(warnings), complete


def publish_public_artifact(
    *,
    artifact_root: Path,
    artifact_id: str,
    artifact_type: str,
    skill_name: str,
    job_id: str,
    source_ids: Iterable[Any],
    status: str,
    summary: dict[str, Any],
    warnings: Iterable[Any],
    source_files: Iterable[PublicFile] = (),
    json_files: Mapping[str, tuple[Any, str]] | None = None,
) -> dict[str, str]:
    artifact_root = artifact_root.resolve(strict=True)
    if not _OPAQUE_ID.fullmatch(artifact_id) or not _OPAQUE_ID.fullmatch(job_id):
        raise ValueError("public artifact and job IDs must be opaque identifiers")
    if status not in {"succeeded", "partial"}:
        raise ValueError("public artifact status must be succeeded or partial")
    if not artifact_type or len(artifact_type) > 128:
        raise ValueError("public artifact type is invalid")
    if not isinstance(summary, dict):
        raise ValueError("public artifact summary must be an object")
    if _json_size(summary) > _MAX_METADATA_BYTES:
        raise ValueError("public artifact summary exceeds the metadata size limit")

    public_root = artifact_root / "public-artifacts" / artifact_id
    public_root.mkdir(parents=True, exist_ok=True)
    collected_warnings = _warnings(warnings)
    files: list[dict[str, Any]] = []

    inline = {"summary.json": (summary, "summary"), **(json_files or {})}
    for relative_name, (value, role) in inline.items():
        relative_name = _safe_relative(relative_name)
        if not isinstance(value, (dict, list)) or _json_size(value) > _MAX_METADATA_BYTES:
            status = "partial"
            collected_warnings = _warnings(
                [*collected_warnings, f"PUBLIC_FILE_OMITTED: {relative_name}: JSON exceeds the metadata size limit"]
            )
            continue
        target = public_root / relative_name
        _atomic_json(target, value)
        relative_path = target.relative_to(artifact_root).as_posix()
        files.append(
            {
                "relative_path": relative_path,
                "media_type": "application/json; charset=utf-8",
                "size_bytes": target.stat().st_size,
                "sha256": sha256_file(target),
                "role": role,
            }
        )

    seen = {item["relative_path"] for item in files}
    visualization_descriptors: list[dict[str, Any]] = []
    for item in source_files:
        try:
            source = _source_file(item.source, artifact_root, item.max_bytes)
            relative_name = _safe_relative(item.relative_name)
            target = public_root / relative_name
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            shutil.copyfile(source, temporary)
            os.replace(temporary, target)
            relative_path = target.relative_to(artifact_root).as_posix()
            if relative_path in seen:
                raise ValueError("duplicate public artifact path")
            seen.add(relative_path)
            files.append(
                {
                    "relative_path": relative_path,
                    "media_type": item.media_type,
                    "size_bytes": target.stat().st_size,
                    "sha256": sha256_file(target),
                    "role": item.role,
                }
            )
            if item.descriptor:
                visualization_descriptors.append(dict(item.descriptor))
        except (OSError, ValueError) as exc:
            status = "partial"
            collected_warnings = _warnings([*collected_warnings, f"PUBLIC_FILE_OMITTED: {item.relative_name}: {exc}"])

    public_summary = dict(summary)
    public_summary.pop("visualizations", None)
    if visualization_descriptors:
        unique = {str(item["chart_id"]): item for item in visualization_descriptors if isinstance(item.get("chart_id"), str)}
        public_summary["visualizations"] = sorted(unique.values(), key=lambda item: int(item.get("display_order", 0)))
        summary_file = public_root / "summary.json"
        _atomic_json(summary_file, public_summary)
        summary_entry = next(item for item in files if item["relative_path"] == summary_file.relative_to(artifact_root).as_posix())
        summary_entry["size_bytes"] = summary_file.stat().st_size
        summary_entry["sha256"] = sha256_file(summary_file)

    manifest = {
        "schema_version": "1.0",
        "artifact_id": artifact_id,
        "artifact_type": artifact_type,
        "producer": {"skill_name": skill_name, "job_id": job_id},
        "source_ids": _source_ids(source_ids),
        "status": status,
        "files": files,
        "summary": public_summary,
        "warnings": collected_warnings,
    }
    manifest_path = public_root / "manifest.json"
    _atomic_json(manifest_path, manifest)
    return {
        "artifact_id": artifact_id,
        "artifact_type": artifact_type,
        "status": status,
        "manifest_relative_path": manifest_path.relative_to(artifact_root).as_posix(),
    }


__all__ = [
    "PublicFile",
    "dataset_source_ids",
    "discover_visualization_pngs",
    "processing_source_ids",
    "public_artifact_id",
    "publish_public_artifact",
    "read_json_object",
    "sha256_file",
]
