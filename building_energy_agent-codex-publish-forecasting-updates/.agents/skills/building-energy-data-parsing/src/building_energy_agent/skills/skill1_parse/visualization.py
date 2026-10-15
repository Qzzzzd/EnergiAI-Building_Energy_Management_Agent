"""Small, local visualisation publisher for Skill 1 DatasetBundles.

The parser owns the DatasetBundle contract.  This module only reads the
published bundle, reduces data for display, and writes an independent,
immutable ``VisualizationBundle``.  It deliberately has no REST/job-store
dependencies and never mutates the source bundle.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

CHART_IDS = (
    "dataset_overview",
    "observations_by_point",
    "time_coverage_by_partition",
    "target_timeseries_preview",
)
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


@dataclass(frozen=True, slots=True)
class VisualizationWarning:
    code: str
    message: str
    chart_id: str | None = None
    details: Mapping[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            **({"chart_id": self.chart_id} if self.chart_id else {}),
            **({"details": dict(self.details)} if self.details else {}),
        }


class VisualizationError(RuntimeError):
    """Sanitised, local visualisation failure."""

    def __init__(self, code: str, message: str, *, chart_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.chart_id = chart_id


def _safe_id(value: str) -> str:
    if not isinstance(value, str) or not value or not _ID_RE.fullmatch(value):
        raise ValueError("bundle ID must be a plain path-safe identifier")
    return value


def _safe_relative(root: Path, relative: str) -> Path:
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
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "DatasetBundle metadata is invalid") from exc
    if not isinstance(value, dict):
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "DatasetBundle metadata must be an object")
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
    selected = values[::stride]
    if values and selected[-1] != values[-1]:
        selected.append(values[-1])
    return selected[:limit]


def _load_pyarrow() -> Any:
    try:
        import pyarrow.dataset as ds  # type: ignore
    except ImportError as exc:
        raise VisualizationError("DEPENDENCY_MISSING", "PyArrow is required for DatasetBundle visualisation") from exc
    return ds


class DatasetBundleReader:
    """Read only the small metadata/column projections needed by charts."""

    def inspect(self, bundle_root: str | Path) -> dict[str, Any]:
        root = Path(bundle_root).expanduser().resolve()
        if not root.is_dir():
            raise VisualizationError("SOURCE_BUNDLE_NOT_FOUND", "DatasetBundle does not exist")
        manifest = _read_json(_safe_relative(root, "manifest.json"))
        report = _read_json(_safe_relative(root, "parse_report.json"))
        bundle_id = manifest.get("dataset_bundle_id")
        if manifest.get("bundle_type") != "DatasetBundle" or manifest.get("bundle_version") != "0.7":
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "unsupported DatasetBundle manifest")
        _safe_id(str(bundle_id))
        if bundle_id != root.name:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "DatasetBundle ID does not match its directory")
        try:
            import pyarrow.parquet as pq  # type: ignore
            points = pq.read_table(_safe_relative(root, "points.parquet"), columns=["point_id", "name", "unit"]).to_pylist()
        except (ImportError, OSError, ValueError, KeyError) as exc:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "points.parquet cannot be read") from exc
        partitions: list[dict[str, Any]] = []
        for item in report.get("worksheets", []):
            if not isinstance(item, Mapping):
                continue
            relative = item.get("output_partition")
            if isinstance(relative, str):
                _safe_relative(root, relative)
                partitions.append({
                    "relative_path": relative,
                    "label": item.get("worksheet_name") or item.get("source_ref") or relative,
                    "time_start": item.get("time_start"),
                    "time_end": item.get("time_end"),
                })
        if not partitions:
            timeseries_root = root / "data" / "timeseries"
            partitions = [
                {"relative_path": path.relative_to(root).as_posix(), "label": path.stem}
                for path in sorted(timeseries_root.rglob("*.parquet"))
                if path.is_file() and not path.is_symlink()
            ]
        return {"root": root, "manifest": manifest, "report": report, "points": points, "partitions": partitions}

    def observation_counts(self, inspection: Mapping[str, Any]) -> Counter[str]:
        counts: Counter[str] = Counter()
        ds = _load_pyarrow()
        for partition in inspection["partitions"]:
            path = _safe_relative(inspection["root"], partition["relative_path"])
            try:
                table = ds.dataset(path, format="parquet").to_table(columns=["point_id"])
            except Exception as exc:
                raise VisualizationError("SOURCE_BUNDLE_INVALID", "timeseries partition cannot be read") from exc
            counts.update(str(value) for value in table.column("point_id").to_pylist() if value is not None)
        return counts

    def target_series(self, inspection: Mapping[str, Any], point_id: str) -> tuple[list[Any], list[float | None]]:
        if not isinstance(point_id, str) or not point_id.strip():
            raise VisualizationError("POINT_ID_NOT_FOUND", "preferred point ID is required")
        known = {str(item.get("point_id")) for item in inspection["points"]}
        if point_id not in known:
            raise VisualizationError("POINT_ID_NOT_FOUND", "preferred point ID is not present in points.parquet")
        ds = _load_pyarrow()
        timestamps: list[Any] = []
        values: list[float | None] = []
        for partition in inspection["partitions"]:
            path = _safe_relative(inspection["root"], partition["relative_path"])
            try:
                table = ds.dataset(path, format="parquet").to_table(
                    columns=["timestamp", "point_id", "value_raw"],
                    filter=ds.field("point_id") == point_id,
                )
            except Exception as exc:
                raise VisualizationError("SOURCE_BUNDLE_INVALID", "target timeseries cannot be read") from exc
            timestamps.extend(table.column("timestamp").to_pylist())
            values.extend(_finite(value) for value in table.column("value_raw").to_pylist())
        ordered = sorted(zip(timestamps, values), key=lambda item: item[0])
        return [item[0] for item in ordered], [item[1] for item in ordered]


class DatasetVisualizationTransformer:
    """Produce bounded chart payloads without changing source semantics."""

    def transform(self, inspection: Mapping[str, Any], *, preferred_point_id: str | None = None) -> dict[str, dict[str, Any]]:
        report = inspection["report"]
        manifest = inspection["manifest"]
        points = inspection["points"]
        payload: dict[str, dict[str, Any]] = {
            "dataset_overview": {
                "cards": {
                    "点位数": len(points),
                    "观测记录数": report.get("record_count"),
                    "工作表数": report.get("worksheet_count", len(inspection["partitions"])),
                    "成功工作表": report.get("successful_worksheet_count"),
                    "失败工作表": report.get("failed_worksheet_count"),
                    "解析警告数": len(report.get("warnings", [])) if isinstance(report.get("warnings", []), list) else 0,
                },
                "time_start": manifest.get("time_start"),
                "time_end": manifest.get("time_end"),
            },
            "observations_by_point": {"counts": inspection["reader"].observation_counts(inspection)},
            "time_coverage_by_partition": {"intervals": [item for item in inspection["partitions"] if item.get("time_start") and item.get("time_end")]},
            "target_timeseries_preview": {"applicable": False, "reason": "未明确提供 preferred_point_id，不猜测目标点。"},
        }
        if preferred_point_id is not None:
            timestamps, values = inspection["reader"].target_series(inspection, preferred_point_id)
            payload["target_timeseries_preview"] = {
                "applicable": any(value is not None for value in values),
                "point_id": preferred_point_id,
                "timestamps": _downsample(timestamps),
                "values": _downsample(values),
            }
        return payload


class DatasetVisualizationRenderer:
    """Render one chart at a time; a failed optional chart cannot abort peers."""

    def __init__(self) -> None:
        self.warnings: list[VisualizationWarning] = []
        self._font_ready = False

    def _plot(self, path: Path, chart_id: str, payload: Mapping[str, Any]) -> tuple[int, int]:
        try:
            import matplotlib
            matplotlib.use("Agg", force=True)
            import matplotlib.pyplot as plt  # type: ignore
            from matplotlib import font_manager  # type: ignore
        except ImportError as exc:
            raise VisualizationError("DEPENDENCY_MISSING", "matplotlib is required for Agg PNG visualisation") from exc
        if not self._font_ready:
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
            self._font_ready = True
        fig, ax = plt.subplots(figsize=(10, 4.2), dpi=120)
        if chart_id == "dataset_overview":
            ax.axis("off")
            cards = payload.get("cards", {})
            ax.text(0.02, 0.9, "数据集概览", fontsize=15, weight="bold")
            ax.text(0.03, 0.72, "\n".join(f"{key}: {value if value is not None else '未提供'}" for key, value in cards.items()), va="top", fontsize=11)
            ax.text(0.03, 0.08, f"时间覆盖: {payload.get('time_start', '未提供')} 至 {payload.get('time_end', '未提供')}", fontsize=9)
        elif chart_id == "observations_by_point":
            counts = payload.get("counts", {})
            ordered = sorted(((str(k), int(v)) for k, v in counts.items()), key=lambda item: (-item[1], item[0]))
            shown, rest = ordered[:20], ordered[20:]
            if rest:
                shown.append(("其他点位", sum(value for _, value in rest)))
            if shown:
                ax.barh([item[0] for item in shown][::-1], [item[1] for item in shown][::-1], color="#1F4E79")
            else:
                ax.text(0.5, 0.5, "无观测记录", ha="center")
            ax.set_title("各点位观测数")
        elif chart_id == "time_coverage_by_partition":
            intervals = payload.get("intervals", [])
            for index, interval in enumerate(intervals):
                start, end = interval.get("time_start"), interval.get("time_end")
                try:
                    x0, x1 = datetime.fromisoformat(str(start).replace("Z", "+00:00")), datetime.fromisoformat(str(end).replace("Z", "+00:00"))
                    ax.plot([x0, x1], [index, index], lw=8, solid_capstyle="butt")
                    ax.text(x0, index + 0.12, str(interval.get("label", "分区")), fontsize=8)
                except ValueError:
                    continue
            ax.set_title("分区时间覆盖")
            ax.set_yticks([])
        elif chart_id == "target_timeseries_preview":
            if not payload.get("applicable"):
                ax.text(0.5, 0.5, str(payload.get("reason", "无可展示数据")), ha="center")
            else:
                timestamps = [datetime.fromisoformat(str(value).replace("Z", "+00:00")) if isinstance(value, str) else value for value in payload.get("timestamps", [])]
                values = [value if value is not None else float("nan") for value in payload.get("values", [])]
                ax.plot(timestamps, values, color="#1F4E79", lw=1.2, marker="o", markersize=2)
                ax.set_title(f"明确点位时序预览｜{payload.get('point_id', '')}")
        else:
            raise ValueError(f"unsupported chart: {chart_id}")
        fig.tight_layout()
        fig.savefig(path, format="png")
        width, height = fig.canvas.get_width_height()
        plt.close(fig)
        return int(width), int(height)

    def render(self, chart_id: str, payload: Mapping[str, Any], path: Path) -> tuple[int, int]:
        path.parent.mkdir(parents=True, exist_ok=True)
        return self._plot(path, chart_id, payload)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _bundle_id(source: Mapping[str, Any], preferred_point_id: str | None) -> str:
    seed = {"skill": "data-parsing", "source_bundle_id": source["id"], "source_manifest_sha256": source["manifest_sha256"], "preferred_point_id": preferred_point_id, "renderer_version": "skill1-visual-v3"}
    return f"visualization-skill1-{hashlib.sha256(_canonical(seed)).hexdigest()[:32]}"


def _publish_path(artifact_root: Path, bundle_id: str) -> Path:
    return artifact_root / "visualization-bundles" / bundle_id


def validate_manifest(manifest_path: str | Path) -> dict[str, Any]:
    """Validate manifest hashes and return the parsed lightweight manifest."""
    path = Path(manifest_path).resolve()
    root = path.parent
    manifest = _read_json(path)
    for relative, expected in manifest.get("file_hashes", {}).items():
        target = _safe_relative(root, relative)
        if not target.is_file() or sha256_file(target) != expected:
            raise VisualizationError("MANIFEST_HASH_MISMATCH", "visualisation artifact hash mismatch")
    return manifest


def publish_visualizations(
    bundle_root: str | Path,
    *,
    artifact_root: str | Path | None = None,
    preferred_point_id: str | None = None,
    fail_charts: Iterable[str] = (),
) -> Path:
    """Publish the fixed Skill 1 chart set and return its manifest path."""
    reader = DatasetBundleReader()
    base = reader.inspect(bundle_root)
    source_manifest_path = base["root"] / "manifest.json"
    source = {"id": base["manifest"]["dataset_bundle_id"], "manifest_sha256": sha256_file(source_manifest_path)}
    root = Path(artifact_root).expanduser().resolve() if artifact_root is not None else base["root"].parent.parent
    bundle_id = _bundle_id(source, preferred_point_id)
    final = _publish_path(root, bundle_id)
    manifest_file = final / "manifest.json"
    if manifest_file.is_file():
        validate_manifest(manifest_file)
        return manifest_file
    base["reader"] = reader
    payloads = DatasetVisualizationTransformer().transform(base, preferred_point_id=preferred_point_id)
    failed = {str(item) for item in fail_charts}
    renderer = DatasetVisualizationRenderer()
    final.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".visualization-skill1-", dir=final.parent))
    entries: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    try:
        for order, chart_id in enumerate(CHART_IDS):
            relative = f"figures/{chart_id}.png"
            if chart_id == "target_timeseries_preview" and not payloads[chart_id].get("applicable"):
                warning = VisualizationWarning("NOT_APPLICABLE", str(payloads[chart_id].get("reason", "未提供明确点位")), chart_id)
                warnings.append(warning.as_dict())
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "not_applicable", "warnings": [warning.as_dict()], "display_order": order})
                continue
            if chart_id in failed:
                warning = VisualizationWarning("RENDER_FAILED", "图表渲染被调用方标记为失败。", chart_id)
                warnings.append(warning.as_dict())
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning.as_dict()], "display_order": order})
                continue
            try:
                output = temporary / relative
                width, height = renderer.render(chart_id, payloads[chart_id], output)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "available", "mime_type": "image/png", "width_px": width, "height_px": height, "sha256": sha256_file(output), "display_order": order})
            except Exception as exc:  # isolated per figure by design
                warning = VisualizationWarning(getattr(exc, "code", "RENDER_FAILED"), "单图渲染失败，其他图表仍可用。", chart_id, {"error_type": type(exc).__name__})
                warnings.append(warning.as_dict())
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning.as_dict()], "display_order": order})
        warnings.extend(item.as_dict() for item in renderer.warnings)
        summary = {"chart_count": len(entries), "available_count": sum(item["status"] == "available" for item in entries), "point_count": len(base["points"]), "record_count": base["report"].get("record_count"), "preferred_point_id": preferred_point_id}
        (temporary / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        file_hashes = {"summary.json": sha256_file(temporary / "summary.json")}
        for entry in entries:
            if entry["status"] == "available":
                file_hashes[entry["relative_path"]] = entry["sha256"]
        manifest = {"bundle_type": "VisualizationBundle", "bundle_version": "1.0", "visualization_bundle_id": bundle_id, "source": {"bundle_type": "DatasetBundle", "bundle_version": "0.7", "bundle_id": source["id"], "manifest_sha256": source["manifest_sha256"]}, "renderer_set_version": "skill1-visual-v3", "theme": {"name": "building-energy-default", "version": "1"}, "status": "succeeded" if all(item["status"] != "failed" for item in entries) else "partial", "figures": entries, "warnings": warnings, "file_hashes": file_hashes}
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        if final.exists():
            validate_manifest(final / "manifest.json")
            return final / "manifest.json"
        temporary.rename(final)
        return final / "manifest.json"
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


# Explicit aliases make the local reader/transform/renderer boundary easy to discover.
read_bundle = DatasetBundleReader
transform_bundle = DatasetVisualizationTransformer
render_chart = DatasetVisualizationRenderer


__all__ = [
    "CHART_IDS",
    "DatasetBundleReader",
    "DatasetVisualizationRenderer",
    "DatasetVisualizationTransformer",
    "VisualizationError",
    "VisualizationWarning",
    "publish_visualizations",
    "sha256_file",
    "validate_manifest",
]
