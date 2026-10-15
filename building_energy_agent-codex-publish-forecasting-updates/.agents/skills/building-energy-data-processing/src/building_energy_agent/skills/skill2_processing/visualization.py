"""Local visualisation publisher for Skill 2 ProcessingBundles.

Only persisted ProcessingBundle fields are read.  The module never fills gaps,
resamples a grid, retrains a model, or writes into the source bundle.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

CHART_IDS = (
    "processed_target_timeline",
    "gap_and_segment_timeline",
    "split_timeline",
    "sample_exclusions",
    "split_sample_counts",
)
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True, slots=True)
class VisualizationWarning:
    code: str
    message: str
    chart_id: str | None = None
    details: Mapping[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.chart_id:
            result["chart_id"] = self.chart_id
        if self.details:
            result["details"] = dict(self.details)
        return result


class VisualizationError(RuntimeError):
    def __init__(self, code: str, message: str, *, chart_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.chart_id = chart_id


def _safe_id(value: str) -> str:
    if not isinstance(value, str) or not value or not _ID_RE.fullmatch(value):
        raise ValueError("bundle ID must be a plain path-safe identifier")
    return value


def _safe_file(root: Path, relative: str) -> Path:
    pure = PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts or relative == ".":
        raise VisualizationError("UNSAFE_PATH", "artifact path must be bundle-relative")
    raw = root / pure
    if raw.is_symlink() or any(parent.is_symlink() for parent in raw.parents if parent != root):
        raise VisualizationError("UNSAFE_PATH", "symlink artifacts are not accepted")
    path = raw.resolve()
    root_real = root.resolve()
    if path != root_real and root_real not in path.parents:
        raise VisualizationError("UNSAFE_PATH", "artifact path escapes its bundle")
    return path


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
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "ProcessingBundle metadata is invalid") from exc
    if not isinstance(value, dict):
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "ProcessingBundle metadata must be an object")
    return value


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _downsample(values: list[Any], limit: int = 5000) -> list[Any]:
    if len(values) <= limit:
        return values
    stride = max(1, math.ceil(len(values) / limit))
    result = values[::stride]
    if values and result[-1] != values[-1]:
        result.append(values[-1])
    return result[:limit]


class ProcessingBundleReader:
    """Inspect and project only columns needed for visualisation."""

    def inspect(self, bundle_root: str | Path) -> dict[str, Any]:
        root = Path(bundle_root).expanduser().resolve()
        if not root.is_dir():
            raise VisualizationError("SOURCE_BUNDLE_NOT_FOUND", "ProcessingBundle does not exist")
        manifest = _read_json(_safe_file(root, "manifest.json"))
        report = _read_json(_safe_file(root, "processing_report.json"))
        split_manifest = _read_json(_safe_file(root, "split_manifest.json"))
        target_metadata = _read_json(_safe_file(root, "target_metadata.json"))
        bundle_id = manifest.get("processing_bundle_id")
        if manifest.get("bundle_type") != "ProcessingBundle" or manifest.get("bundle_version") != "0.7":
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "unsupported ProcessingBundle manifest")
        _safe_id(str(bundle_id))
        if bundle_id != root.name:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "ProcessingBundle ID does not match its directory")
        mode = str(manifest.get("processing_mode") or split_manifest.get("mode") or "backtest")
        processed_path: Path | None = None
        processed_root = root / "data" / "processed_timeseries"
        for candidate in sorted(processed_root.rglob("*.parquet")) if processed_root.is_dir() else ():
            if candidate.is_file() and not candidate.is_symlink():
                processed_path = candidate
                break
        return {"root": root, "manifest": manifest, "report": report, "split_manifest": split_manifest, "target_metadata": target_metadata, "mode": mode, "processed_path": processed_path}

    def processed_rows(self, inspection: Mapping[str, Any]) -> list[dict[str, Any]]:
        path = inspection.get("processed_path")
        if not isinstance(path, Path):
            return []
        try:
            import pyarrow.parquet as pq  # type: ignore
            schema = pq.read_schema(path)
            required = [name for name in ("timestamp", "target_value", "is_observed", "gap_class", "segment_id") if name in schema.names]
            if not {"timestamp", "target_value"}.issubset(required):
                return []
            table = pq.read_table(path, columns=required)
            columns = {name: table.column(name).to_pylist() for name in required}
        except (ImportError, OSError, ValueError) as exc:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "processed_timeseries cannot be read") from exc
        rows: list[dict[str, Any]] = []
        for index in range(len(columns["timestamp"])):
            rows.append({name: (value if name != "target_value" else _finite(value)) for name, value in ((column, columns[column][index]) for column in required)})
        return rows


class ProcessingVisualizationTransformer:
    def transform(self, inspection: Mapping[str, Any], rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        report = inspection["report"]
        split_manifest = inspection["split_manifest"]
        split_payload = split_manifest.get("splits", {}) if isinstance(split_manifest.get("splits", {}), Mapping) else {}
        counts: dict[str, int] = {}
        ranges: list[dict[str, Any]] = []
        for split in ("train", "validation", "test", "future"):
            item = split_payload.get(split)
            if not isinstance(item, Mapping):
                continue
            count = item.get("sample_count")
            if isinstance(count, int) and count >= 0:
                counts[split] = count
            if item.get("forecast_start") and item.get("forecast_end"):
                ranges.append({"split": split, "time_start": item["forecast_start"], "time_end": item["forecast_end"]})
        exclusions: dict[str, int] = {}
        for key in ("sample_plan_exclusion_counts", "history_exclusion_counts", "sample_exclusion_counts"):
            value = report.get(key)
            if isinstance(value, Mapping):
                for reason, number in value.items():
                    if isinstance(reason, str) and isinstance(number, int) and number >= 0:
                        exclusions[reason] = exclusions.get(reason, 0) + number
        ordered = sorted(rows, key=lambda row: (str(row.get("timestamp")),))
        status_intervals: list[dict[str, Any]] = []
        if ordered:
            start = 0
            status_columns = [name for name in ("gap_class", "segment_id") if name in ordered[0]]
            for index in range(1, len(ordered) + 1):
                changed = index == len(ordered) or any(ordered[index - 1].get(name) != ordered[index].get(name) for name in status_columns)
                if changed:
                    status_intervals.append({"time_start": ordered[start].get("timestamp"), "time_end": ordered[index - 1].get("timestamp"), **{name: ordered[start].get(name) for name in status_columns}})
                    start = index
        payload: dict[str, dict[str, Any]] = {
            "processed_target_timeline": {"timestamps": _downsample([row.get("timestamp") for row in ordered]), "values": _downsample([row.get("target_value") for row in ordered]), "unit": inspection["target_metadata"].get("target_unit"), "row_count": len(ordered), "note": "只展示 Skill 2 已产出字段；未重采样、未插值。"},
            "gap_and_segment_timeline": {"intervals": status_intervals, "note": "仅合并相邻且标签相同的既有行；未重新推断缺口或分段。"},
            "split_timeline": {"intervals": ranges, "mode": inspection["mode"]},
            "sample_exclusions": {"counts": exclusions},
            "split_sample_counts": {"counts": counts, "mode": inspection["mode"]},
        }
        return payload


class ProcessingVisualizationRenderer:
    def __init__(self) -> None:
        self.warnings: list[VisualizationWarning] = []
        self._font_checked = False

    def render(self, chart_id: str, payload: Mapping[str, Any], path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            import matplotlib
            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt  # type: ignore
            from matplotlib import font_manager  # type: ignore
        except ImportError as exc:
            raise VisualizationError("DEPENDENCY_MISSING", "matplotlib is required for Agg PNG visualisation") from exc
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
                self.warnings.append(VisualizationWarning("DISPLAY_FONT_FALLBACK", "未发现已知中文字体，回退到 Matplotlib 默认字体。"))
            self._font_checked = True
        fig, ax = plt.subplots(figsize=(10, 4.2), dpi=120)
        if chart_id == "processed_target_timeline":
            values = [value if value is not None else float("nan") for value in payload.get("values", [])]
            timestamps = [datetime.fromisoformat(str(value).replace("Z", "+00:00")) if isinstance(value, str) else value for value in payload.get("timestamps", [])]
            if values:
                ax.plot(timestamps, values, color="#1F4E79", lw=1.1)
            else:
                ax.text(0.5, 0.5, "无处理后目标数据", ha="center")
            ax.set_title("处理后目标曲线")
        elif chart_id == "gap_and_segment_timeline":
            intervals = payload.get("intervals", [])
            for index, item in enumerate(intervals):
                try:
                    start = datetime.fromisoformat(str(item["time_start"]).replace("Z", "+00:00"))
                    end = datetime.fromisoformat(str(item["time_end"]).replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                ax.plot([start, end], [index, index], lw=8, solid_capstyle="butt")
                ax.text(start, index + 0.1, f"{item.get('gap_class', '')}/{item.get('segment_id', '')}", fontsize=8)
            ax.set_yticks([])
            ax.set_title("缺口与分段（已持久化标签）")
        elif chart_id == "split_timeline":
            for index, item in enumerate(payload.get("intervals", [])):
                try:
                    start = datetime.fromisoformat(str(item["time_start"]).replace("Z", "+00:00"))
                    end = datetime.fromisoformat(str(item["time_end"]).replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                ax.plot([start, end], [index, index], lw=10, solid_capstyle="butt", label=str(item.get("split")))
            ax.set_yticks([])
            ax.set_title(f"样本时间切分｜{payload.get('mode', '')}")
        elif chart_id in {"sample_exclusions", "split_sample_counts"}:
            counts = payload.get("counts", {})
            labels = list(counts)
            values = [counts[label] for label in labels]
            if labels:
                ax.barh(labels[::-1], values[::-1], color="#E1812C" if chart_id == "sample_exclusions" else "#3274A1")
            else:
                ax.text(0.5, 0.5, "未提供显式计数", ha="center")
            ax.set_title("样本排除原因" if chart_id == "sample_exclusions" else f"各 Split 样本数量｜{payload.get('mode', '')}")
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
    seed = {"skill": "data-processing", "source_bundle_id": source_id, "source_manifest_sha256": source_hash, "renderer_version": "skill2-visual-v3"}
    return f"visualization-skill2-{hashlib.sha256(_canonical(seed)).hexdigest()[:32]}"


def validate_manifest(manifest_path: str | Path) -> dict[str, Any]:
    path = Path(manifest_path).resolve()
    manifest = _read_json(path)
    for relative, expected in manifest.get("file_hashes", {}).items():
        target = _safe_file(path.parent, relative)
        if not target.is_file() or sha256_file(target) != expected:
            raise VisualizationError("MANIFEST_HASH_MISMATCH", "visualisation artifact hash mismatch")
    return manifest


def publish_visualizations(
    bundle_root: str | Path,
    *,
    artifact_root: str | Path | None = None,
    fail_charts: Iterable[str] = (),
) -> Path:
    reader = ProcessingBundleReader()
    inspection = reader.inspect(bundle_root)
    source_hash = sha256_file(inspection["root"] / "manifest.json")
    source_id = str(inspection["manifest"]["processing_bundle_id"])
    bundle_id = _bundle_id(source_id, source_hash)
    root = Path(artifact_root).expanduser().resolve() if artifact_root is not None else inspection["root"].parent.parent
    final = root / "visualization-bundles" / bundle_id
    if (final / "manifest.json").is_file():
        validate_manifest(final / "manifest.json")
        return final / "manifest.json"
    rows = reader.processed_rows(inspection)
    payloads = ProcessingVisualizationTransformer().transform(inspection, rows)
    renderer = ProcessingVisualizationRenderer()
    failed = {str(item) for item in fail_charts}
    final.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".visualization-skill2-", dir=final.parent))
    entries: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    try:
        for order, chart_id in enumerate(CHART_IDS):
            relative = f"figures/{chart_id}.png"
            if chart_id in failed:
                warning = VisualizationWarning("RENDER_FAILED", "图表渲染被调用方标记为失败。", chart_id)
                warnings.append(warning.as_dict())
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning.as_dict()], "display_order": order})
                continue
            try:
                output = temporary / relative
                width, height = renderer.render(chart_id, payloads[chart_id], output)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "available", "mime_type": "image/png", "width_px": width, "height_px": height, "sha256": sha256_file(output), "display_order": order})
            except Exception as exc:
                warning = VisualizationWarning(getattr(exc, "code", "RENDER_FAILED"), "单图渲染失败，其他图表仍可用。", chart_id, {"error_type": type(exc).__name__})
                warnings.append(warning.as_dict())
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning.as_dict()], "display_order": order})
        warnings.extend(item.as_dict() for item in renderer.warnings)
        summary = {"chart_count": len(entries), "available_count": sum(item["status"] == "available" for item in entries), "mode": inspection["mode"], "processed_row_count": len(rows), "split_sample_counts": payloads["split_sample_counts"]["counts"], "exclusion_counts": payloads["sample_exclusions"]["counts"]}
        (temporary / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        file_hashes = {"summary.json": sha256_file(temporary / "summary.json")}
        for entry in entries:
            if entry["status"] == "available":
                file_hashes[entry["relative_path"]] = entry["sha256"]
        manifest = {"bundle_type": "VisualizationBundle", "bundle_version": "1.0", "visualization_bundle_id": bundle_id, "source": {"bundle_type": "ProcessingBundle", "bundle_version": "0.7", "bundle_id": source_id, "manifest_sha256": source_hash}, "renderer_set_version": "skill2-visual-v3", "theme": {"name": "building-energy-default", "version": "1"}, "status": "succeeded" if all(item["status"] != "failed" for item in entries) else "partial", "figures": entries, "warnings": warnings, "file_hashes": file_hashes}
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


read_bundle = ProcessingBundleReader
transform_bundle = ProcessingVisualizationTransformer
render_chart = ProcessingVisualizationRenderer

__all__ = [
    "CHART_IDS",
    "ProcessingBundleReader",
    "ProcessingVisualizationRenderer",
    "ProcessingVisualizationTransformer",
    "VisualizationError",
    "VisualizationWarning",
    "publish_visualizations",
    "sha256_file",
    "validate_manifest",
]
