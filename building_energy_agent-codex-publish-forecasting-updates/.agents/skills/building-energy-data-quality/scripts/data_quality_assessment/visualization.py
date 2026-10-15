"""Local PNG/manifest publisher for QualityAssessmentBundle results."""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

CHART_IDS = (
    "quality_score_overview",
    "quality_overall_score",
    "issue_severity_counts",
    "issues_by_dimension",
    "affected_scope_summary",
)
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class VisualizationError(RuntimeError):
    def __init__(self, code: str, message: str, *, chart_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.chart_id = chart_id


def _safe_file(root: Path, relative: str) -> Path:
    pure = PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts or relative == ".":
        raise VisualizationError("UNSAFE_PATH", "artifact path must be bundle-relative")
    raw = root / pure
    if raw.is_symlink() or any(parent.is_symlink() for parent in raw.parents if parent != root):
        raise VisualizationError("UNSAFE_PATH", "symlink artifacts are not accepted")
    candidate = raw.resolve()
    root_real = root.resolve()
    if candidate != root_real and root_real not in candidate.parents:
        raise VisualizationError("UNSAFE_PATH", "artifact path escapes its bundle")
    return candidate


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "QualityAssessmentBundle JSON is invalid") from exc
    if not isinstance(value, dict):
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "QualityAssessmentBundle JSON must be an object")
    return value


class QualityAssessmentBundleReader:
    def inspect(self, bundle_root: str | Path) -> dict[str, Any]:
        root = Path(bundle_root).expanduser().resolve()
        if not root.is_dir():
            raise VisualizationError("SOURCE_BUNDLE_NOT_FOUND", "QualityAssessmentBundle does not exist")
        manifest = _read_json(_safe_file(root, "manifest.json"))
        result = _read_json(_safe_file(root, "quality_result.json"))
        bundle_id = manifest.get("quality_assessment_bundle_id")
        if manifest.get("bundle_type") != "QualityAssessmentBundle" or manifest.get("bundle_version") != "0.7" or not isinstance(bundle_id, str) or not _ID_RE.fullmatch(bundle_id) or bundle_id != root.name:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "QualityAssessmentBundle manifest identity is invalid")
        if result.get("source_bundle_id") != manifest.get("source_bundle_id"):
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "quality_result source bundle differs from manifest")
        return {"root": root, "manifest": manifest, "result": result}


class QualityVisualizationTransformer:
    def transform(self, inspection: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
        result = inspection["result"]
        dimensions = result.get("dimensions", {})
        if not isinstance(dimensions, Mapping):
            dimensions = {}
        dim_ids = [f"DQ{i}" for i in range(1, 7)]
        scores = [dimensions.get(key, {}).get("score") if isinstance(dimensions.get(key), Mapping) else None for key in dim_ids]
        issues = result.get("issues", []) if isinstance(result.get("issues", []), list) else []
        severity_counts = {severity: sum(1 for item in issues if isinstance(item, Mapping) and item.get("severity") == severity) for severity in ("info", "warning", "critical")}
        by_dimension = {key: {severity: sum(1 for item in issues if isinstance(item, Mapping) and item.get("dimension") == key and item.get("severity") == severity) for severity in ("info", "warning", "critical")} for key in dim_ids}
        scope = result.get("effective_scope", {}) if isinstance(result.get("effective_scope", {}), Mapping) else {}
        affected_observations = 0
        for item in issues:
            if not isinstance(item, Mapping):
                continue
            affected = item.get("affected_scope", {})
            if isinstance(affected, Mapping) and isinstance(affected.get("count"), int):
                affected_observations += max(0, int(affected["count"]))
        return {
            "quality_score_overview": {"dimension_ids": dim_ids, "scores": scores},
            "quality_overall_score": {"score": result.get("overall_score"), "available": result.get("overall_score") is not None},
            "issue_severity_counts": {"severity_ids": list(severity_counts), "counts": severity_counts},
            "issues_by_dimension": {"dimension_ids": dim_ids, "severity_counts": by_dimension},
            "affected_scope_summary": {"included_point_count": scope.get("included_point_count"), "affected_point_count": len({point for item in issues if isinstance(item, Mapping) for point in (item.get("affected_scope", {}).get("point_ids", []) if isinstance(item.get("affected_scope", {}), Mapping) else [])}), "issue_count": len(issues), "affected_observation_count": affected_observations, "time_start": scope.get("time_start"), "time_end": scope.get("time_end")},
        }


class QualityVisualizationRenderer:
    def __init__(self) -> None:
        self.warnings: list[dict[str, Any]] = []
        self._font_checked = False

    def render(self, chart_id: str, payload: Mapping[str, Any], path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            import matplotlib
            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt  # type: ignore
            from matplotlib import font_manager  # type: ignore
        except ImportError as exc:
            raise VisualizationError("DEPENDENCY_MISSING", "matplotlib is required for Agg PNG visualisation", chart_id=chart_id) from exc
        if not self._font_checked:
            available_fonts = {
                font.name.casefold(): font.name
                for font in font_manager.fontManager.ttflist
            }
            known_cjk_fonts = (
                "Microsoft YaHei",
                "Noto Sans CJK SC",
                "SimHei",
                "Source Han Sans SC",
            )
            selected_font = next(
                (
                    available_fonts[name.casefold()]
                    for name in known_cjk_fonts
                    if name.casefold() in available_fonts
                ),
                None,
            )
            if selected_font:
                matplotlib.rcParams["font.sans-serif"] = [
                    selected_font,
                    *[
                        name
                        for name in matplotlib.rcParams["font.sans-serif"]
                        if name.casefold() != selected_font.casefold()
                    ],
                ]
                matplotlib.rcParams["axes.unicode_minus"] = False
            else:
                self.warnings.append({"code": "DISPLAY_FONT_FALLBACK", "message": "未发现已知中文字体，回退到 Matplotlib 默认字体。"})
            self._font_checked = True
        fig, ax = plt.subplots(figsize=(10, 4.2), dpi=120)
        if chart_id == "quality_score_overview":
            labels = list(payload.get("dimension_ids", []))
            values = [float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else float("nan") for value in payload.get("scores", [])]
            ax.bar(labels, values, color="#3274A1")
            ax.set_ylim(0, 100)
            ax.set_title("数据质量六维评分")
        elif chart_id == "quality_overall_score":
            ax.axis("off")
            score = payload.get("score")
            ax.text(0.5, 0.55, "未提供" if score is None else f"{float(score):.2f}", ha="center", va="center", fontsize=28, color="#1F4E79")
            ax.text(0.5, 0.25, "综合数据质量评分", ha="center", fontsize=14)
        elif chart_id == "issue_severity_counts":
            labels = list(payload.get("severity_ids", []))
            values = [payload.get("counts", {}).get(label, 0) for label in labels]
            ax.bar(labels, values, color=["#3274A1", "#E1812C", "#C43C39"])
            ax.set_title("质量问题严重性分布")
        elif chart_id == "issues_by_dimension":
            labels = list(payload.get("dimension_ids", []))
            counts = payload.get("severity_counts", {})
            bottom = [0] * len(labels)
            for severity, color in (("info", "#3274A1"), ("warning", "#E1812C"), ("critical", "#C43C39")):
                values = [counts.get(label, {}).get(severity, 0) for label in labels]
                ax.bar(labels, values, bottom=bottom, label=severity, color=color)
                bottom = [left + value for left, value in zip(bottom, values)]
            ax.legend()
            ax.set_title("质量问题按维度分布")
        elif chart_id == "affected_scope_summary":
            ax.axis("off")
            fields = (("纳入点位", payload.get("included_point_count")), ("受影响点位", payload.get("affected_point_count")), ("问题数量", payload.get("issue_count")), ("受影响观测数", payload.get("affected_observation_count")))
            ax.text(0.05, 0.85, "\n".join(f"{key}: {value if value is not None else '未提供'}" for key, value in fields), va="top", fontsize=14)
            ax.text(0.05, 0.15, f"{payload.get('time_start', '')} 至 {payload.get('time_end', '')}", fontsize=9)
        else:
            raise ValueError(f"unsupported chart: {chart_id}")
        fig.tight_layout()
        fig.savefig(path, format="png")
        width, height = fig.canvas.get_width_height()
        plt.close(fig)
        return int(width), int(height)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _bundle_id(source_id: str, source_hash: str) -> str:
    seed = {"skill": "data-quality-assessment", "source_bundle_id": source_id, "source_manifest_sha256": source_hash, "renderer_version": "skill3-visual-v3"}
    return f"visualization-skill3-{hashlib.sha256(_canonical(seed)).hexdigest()[:32]}"


def validate_manifest(manifest_path: str | Path) -> dict[str, Any]:
    path = Path(manifest_path).resolve()
    manifest = _read_json(path)
    for relative, expected in manifest.get("file_hashes", {}).items():
        target = _safe_file(path.parent, relative)
        if not target.is_file() or sha256_file(target) != expected:
            raise VisualizationError("MANIFEST_HASH_MISMATCH", "visualisation artifact hash mismatch")
    return manifest


def publish_visualizations(bundle_root: str | Path, *, artifact_root: str | Path | None = None, fail_charts: Iterable[str] = ()) -> Path:
    reader = QualityAssessmentBundleReader()
    inspection = reader.inspect(bundle_root)
    source_hash = sha256_file(inspection["root"] / "manifest.json")
    source_id = str(inspection["manifest"]["quality_assessment_bundle_id"])
    bundle_id = _bundle_id(source_id, source_hash)
    root = Path(artifact_root).expanduser().resolve() if artifact_root is not None else inspection["root"].parent.parent
    final = root / "visualization-bundles" / bundle_id
    if (final / "manifest.json").is_file():
        validate_manifest(final / "manifest.json")
        return final / "manifest.json"
    payloads = QualityVisualizationTransformer().transform(inspection)
    renderer = QualityVisualizationRenderer()
    failed = {str(item) for item in fail_charts}
    final.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".visualization-skill3-", dir=final.parent))
    entries: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    try:
        for order, chart_id in enumerate(CHART_IDS):
            relative = f"figures/{chart_id}.png"
            if chart_id in failed:
                warning = {"code": "RENDER_FAILED", "message": "图表渲染被调用方标记为失败。", "chart_id": chart_id}
                warnings.append(warning)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning], "display_order": order})
                continue
            try:
                width, height = renderer.render(chart_id, payloads[chart_id], temporary / relative)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "available", "mime_type": "image/png", "width_px": width, "height_px": height, "sha256": sha256_file(temporary / relative), "display_order": order})
            except Exception as exc:
                warning = {"code": getattr(exc, "code", "RENDER_FAILED"), "message": "单图渲染失败，其他图表仍可用。", "chart_id": chart_id, "details": {"error_type": type(exc).__name__}}
                warnings.append(warning)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning], "display_order": order})
        warnings.extend(renderer.warnings)
        summary = {"chart_count": len(entries), "available_count": sum(item["status"] == "available" for item in entries), "overall_score": inspection["result"].get("overall_score"), "issue_count": len(inspection["result"].get("issues", [])) if isinstance(inspection["result"].get("issues", []), list) else 0}
        (temporary / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        file_hashes = {"summary.json": sha256_file(temporary / "summary.json")}
        for entry in entries:
            if entry["status"] == "available":
                file_hashes[entry["relative_path"]] = entry["sha256"]
        manifest = {"bundle_type": "VisualizationBundle", "bundle_version": "1.0", "visualization_bundle_id": bundle_id, "source": {"bundle_type": "QualityAssessmentBundle", "bundle_version": "0.7", "bundle_id": source_id, "manifest_sha256": source_hash}, "renderer_set_version": "skill3-visual-v3", "theme": {"name": "building-energy-default", "version": "1"}, "status": "succeeded" if all(item["status"] != "failed" for item in entries) else "partial", "figures": entries, "warnings": warnings, "file_hashes": file_hashes}
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        if final.exists():
            validate_manifest(final / "manifest.json")
            shutil.rmtree(temporary, ignore_errors=True)
            return final / "manifest.json"
        temporary.rename(final)
        return final / "manifest.json"
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


read_bundle = QualityAssessmentBundleReader
transform_bundle = QualityVisualizationTransformer
render_chart = QualityVisualizationRenderer

__all__ = ["CHART_IDS", "QualityAssessmentBundleReader", "QualityVisualizationRenderer", "QualityVisualizationTransformer", "VisualizationError", "publish_visualizations", "sha256_file", "validate_manifest"]
