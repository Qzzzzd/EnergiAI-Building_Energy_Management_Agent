"""Local visualisation publisher for Skill 4 model/evaluation/forecast bundles.

Evaluation PNGs are hash-checked and copied byte-for-byte when reusable.  New
charts read bounded columns only and are written to an independent immutable
visualisation bundle; no model training or prediction is repeated here.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping

EVALUATION_CHART_IDS = (
    "metrics_overview",
    "actual_vs_prediction",
    "actual_vs_prediction_scatter",
    "residual_distribution",
    "feature_importance",
    "training_history",
    "error_by_horizon",
)
FORECAST_CHART_IDS = (
    "forecast_timeseries",
    "forecast_summary",
    "forecast_by_horizon",
    "forecast_threshold",
)
MODEL_CHART_IDS = ("model_summary",)
_ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_REUSED = {
    "actual_vs_prediction": "figures/test_actual_vs_prediction.png",
    "actual_vs_prediction_scatter": "figures/test_actual_vs_prediction_scatter.png",
    "feature_importance": "figures/feature_importance_gain_top20.png",
    "residual_distribution": "figures/test_residual_distribution.png",
}


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
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "forecast artifact JSON is invalid") from exc
    if not isinstance(value, dict):
        raise VisualizationError("SOURCE_BUNDLE_INVALID", "forecast artifact JSON must be an object")
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


class ForecastVisualizationReader:
    """Inspect source bundle type and load bounded chart payloads."""

    def inspect(self, bundle_root: str | Path) -> dict[str, Any]:
        root = Path(bundle_root).expanduser().resolve()
        if not root.is_dir():
            raise VisualizationError("SOURCE_BUNDLE_NOT_FOUND", "forecast artifact bundle does not exist")
        manifest = _read_json(_safe_file(root, "manifest.json"))
        bundle_type = manifest.get("bundle_type")
        bundle_id_key = {"ModelBundle": "model_bundle_id", "EvaluationBundle": "evaluation_bundle_id", "ForecastBundle": "forecast_bundle_id"}.get(str(bundle_type))
        bundle_id = manifest.get(bundle_id_key) if bundle_id_key else None
        if bundle_type not in {"ModelBundle", "EvaluationBundle", "ForecastBundle"} or not isinstance(bundle_id, str) or not _ID_RE.fullmatch(bundle_id) or bundle_id != root.name:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "unsupported Skill 4 bundle identity")
        payload: dict[str, Any] = {"root": root, "manifest": manifest, "bundle_type": bundle_type, "bundle_id": bundle_id}
        if bundle_type == "EvaluationBundle":
            payload["metrics"] = _read_json(_safe_file(root, "metrics.json"))
            payload["history"] = _read_json(_safe_file(root, "training_history.json"))
            payload["file_hashes"] = manifest.get("file_hashes", {})
            payload["predictions"] = self._read_parquet(root / "predictions" / "test.parquet", ("target_timestamp", "actual_value", "prediction", "residual", "horizon_step", "evaluation_eligible"))
            payload["importance"] = self._read_parquet(root / "feature_importance.parquet", ("feature_name", "gain"))
            payload["reused"] = self._discover_reused(root, payload["file_hashes"])
            model_id = manifest.get("model_bundle_id")
            if isinstance(model_id, str) and _ID_RE.fullmatch(model_id):
                model_path = root.parent.parent / "model-bundles" / model_id
                if model_path.is_dir():
                    payload["model"] = self._read_model(model_path)
        elif bundle_type == "ForecastBundle":
            payload["predictions"] = self._read_parquet(root / "predictions.parquet", ("target_timestamp", "horizon_step", "prediction", "prediction_raw"))
            model_id = manifest.get("model_bundle_id")
            if isinstance(model_id, str) and _ID_RE.fullmatch(model_id):
                model_path = root.parent.parent / "model-bundles" / model_id
                if model_path.is_dir():
                    payload["model"] = self._read_model(model_path)
        else:
            payload["model"] = self._read_model(root)
        return payload

    @staticmethod
    def _read_model(root: Path) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name in ("training_summary.json", "training_config.json"):
            path = root / name
            if path.is_file() and not path.is_symlink():
                result[name[:-5]] = _read_json(path)
        return result

    @staticmethod
    def _read_parquet(path: Path, columns: tuple[str, ...]) -> list[dict[str, Any]]:
        if not path.is_file() or path.is_symlink():
            return []
        try:
            import pyarrow.parquet as pq  # type: ignore
            available = set(pq.read_schema(path).names)
            selected = [name for name in columns if name in available]
            table = pq.read_table(path, columns=selected)
            values = {name: table.column(name).to_pylist() for name in selected}
        except (ImportError, OSError, ValueError) as exc:
            raise VisualizationError("SOURCE_BUNDLE_INVALID", "prediction/evaluation parquet cannot be read") from exc
        rows: list[dict[str, Any]] = []
        if not selected:
            return rows
        for index in range(len(values[selected[0]])):
            rows.append({name: (value if name not in {"prediction", "prediction_raw", "actual_value", "residual", "gain"} else _finite(value)) for name, value in ((name, values[name][index]) for name in selected)})
        return rows

    @staticmethod
    def _paired_rows(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """Keep finite, evaluation-eligible actual/prediction pairs."""
        paired: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, Mapping) or not row.get("evaluation_eligible", True):
                continue
            actual = _finite(row.get("actual_value"))
            prediction = _finite(row.get("prediction"))
            if actual is None or prediction is None:
                continue
            item = dict(row)
            item["actual_value"] = actual
            item["prediction"] = prediction
            paired.append(item)
        return paired

    @staticmethod
    def _discover_reused(root: Path, declared: Mapping[str, Any]) -> dict[str, Path]:
        reusable: dict[str, Path] = {}
        for chart_id, relative in _REUSED.items():
            path = _safe_file(root, relative)
            expected = declared.get(relative) if isinstance(declared, Mapping) else None
            if path.is_file() and isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected) and sha256_file(path) == expected and path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"):
                reusable[chart_id] = path
        return reusable


class ForecastVisualizationTransformer:
    def transform(self, inspection: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
        bundle_type = inspection["bundle_type"]
        model = inspection.get("model", {})
        summary = model.get("training_summary", {}) if isinstance(model, Mapping) else {}
        cards = {"模型类型": summary.get("model_type"), "最大预测步长": summary.get("maximum_horizon_step"), "最佳迭代": summary.get("best_iteration"), "训练耗时(秒)": summary.get("training_duration_seconds")}
        payload: dict[str, dict[str, Any]] = {"model_summary": cards}
        rows = inspection.get("predictions", []) if isinstance(inspection.get("predictions", []), list) else []
        if bundle_type == "EvaluationBundle":
            metrics = inspection.get("metrics", {})
            test_metrics = metrics.get("test", {}) if isinstance(metrics, Mapping) else {}
            validation_metrics = metrics.get("validation", {}) if isinstance(metrics, Mapping) else {}
            eligible = ForecastVisualizationReader._paired_rows(rows)
            payload.update({
                "metrics_overview": {"validation": validation_metrics, "test": test_metrics},
                "actual_vs_prediction": {"rows": _downsample(eligible)},
                "actual_vs_prediction_scatter": {"actual": _downsample([row["actual_value"] for row in eligible]), "prediction": _downsample([row["prediction"] for row in eligible]), "paired_count": len(eligible)},
                "residual_distribution": {"residual": _downsample([row.get("residual") for row in eligible if row.get("residual") is not None])},
                "feature_importance": {"rows": sorted(inspection.get("importance", []), key=lambda row: float(row.get("gain") or 0), reverse=True)[:20]},
                "training_history": inspection.get("history", {}),
                "error_by_horizon": {"rows": metrics.get("test_by_horizon", []) if isinstance(metrics, Mapping) else []},
            })
        elif bundle_type == "ForecastBundle":
            timestamps = _downsample([row.get("target_timestamp") for row in rows])
            predictions = _downsample([row.get("prediction") for row in rows])
            payload.update({
                "forecast_timeseries": {"timestamps": timestamps, "predictions": predictions, "unit": inspection["manifest"].get("target_unit")},
                "forecast_summary": {"prediction_count": len(rows), "valid_prediction_count": sum(row.get("prediction") is not None for row in rows), "minimum": min((row["prediction"] for row in rows if row.get("prediction") is not None), default=None), "maximum": max((row["prediction"] for row in rows if row.get("prediction") is not None), default=None), "mean": (sum(row["prediction"] for row in rows if row.get("prediction") is not None) / max(1, sum(row.get("prediction") is not None for row in rows)))},
                "forecast_by_horizon": {"horizon_steps": _downsample([row.get("horizon_step") for row in rows]), "predictions": predictions},
                "forecast_threshold": {"timestamps": timestamps, "predictions": predictions, "threshold": None},
            })
        return payload


class ForecastVisualizationRenderer:
    def __init__(self) -> None:
        self.warnings: list[dict[str, Any]] = []
        self._font_checked = False

    @staticmethod
    def _scatter_pairs(payload: Mapping[str, Any]) -> tuple[list[float], list[float]]:
        """Validate the two-dimensional finite pair input for a scatter plot."""
        actual_values = payload.get("actual", [])
        prediction_values = payload.get("prediction", [])
        if not isinstance(actual_values, (list, tuple)) or not isinstance(prediction_values, (list, tuple)):
            raise VisualizationError(
                "PLOT_INPUT_INVALID",
                "actual_vs_prediction_scatter requires paired one-dimensional values.",
                chart_id="actual_vs_prediction_scatter",
            )
        if len(actual_values) != len(prediction_values):
            raise VisualizationError(
                "PREDICTION_SHAPE_MISMATCH",
                "actual_vs_prediction_scatter requires equal actual and prediction lengths.",
                chart_id="actual_vs_prediction_scatter",
            )
        actual: list[float] = []
        prediction: list[float] = []
        for actual_value, prediction_value in zip(actual_values, prediction_values, strict=True):
            actual_number = _finite(actual_value)
            prediction_number = _finite(prediction_value)
            if actual_number is None or prediction_number is None:
                continue
            actual.append(actual_number)
            prediction.append(prediction_number)
        if len(actual) < 2:
            raise VisualizationError(
                "INSUFFICIENT_PAIRED_SAMPLES",
                "At least two finite actual/prediction pairs are required for a scatter plot.",
                chart_id="actual_vs_prediction_scatter",
            )
        return actual, prediction

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
        if chart_id == "model_summary":
            ax.axis("off")
            ax.text(0.04, 0.88, "模型摘要", fontsize=16, weight="bold")
            ax.text(0.05, 0.72, "\n".join(f"{key}: {value if value is not None else '未提供'}" for key, value in payload.items()), va="top", fontsize=12)
        elif chart_id == "metrics_overview":
            labels = ["CVRMSE", "RMSE", "MAE", "R²"]
            test = payload.get("test", {})
            values = [test.get("cvrmse_percent"), test.get("rmse"), test.get("mae"), test.get("r2")]
            values = [float(value) if isinstance(value, (int, float)) and math.isfinite(float(value)) else 0 for value in values]
            ax.bar(labels, values, color="#3274A1")
            ax.set_title("模型评价指标")
        elif chart_id in {"actual_vs_prediction", "forecast_timeseries"}:
            if chart_id == "actual_vs_prediction":
                rows = payload.get("rows", [])
                x = [row.get("target_timestamp") for row in rows]
                actual = [row.get("actual_value") for row in rows]
                prediction = [row.get("prediction") for row in rows]
                ax.plot(x, actual, label="实际值", color="#1F4E79")
                ax.plot(x, prediction, label="预测值", color="#E67E22", linestyle="--")
                ax.legend()
            else:
                x = [datetime.fromisoformat(str(value).replace("Z", "+00:00")) if isinstance(value, str) else value for value in payload.get("timestamps", [])]
                ax.plot(x, payload.get("predictions", []), color="#E67E22")
            ax.set_title("测试集实际值与预测值" if chart_id == "actual_vs_prediction" else "未来负荷预测")
        elif chart_id == "actual_vs_prediction_scatter":
            actual, prediction = self._scatter_pairs(payload)
            ax.scatter(actual, prediction, s=8, alpha=.5)
            values = [*actual, *prediction]
            low, high = min(values), max(values)
            ax.plot([low, high], [low, high], linestyle="--", color="black")
            ax.set_xlabel("实际值")
            ax.set_ylabel("预测值")
            ax.set_title("实际值—预测值散点")
        elif chart_id == "residual_distribution":
            ax.hist(payload.get("residual", []), bins=30, color="#7656A3")
            ax.axvline(0, color="black", linestyle="--")
            ax.set_title("残差分布")
        elif chart_id == "feature_importance":
            rows = list(payload.get("rows", []))
            rows = rows[::-1]
            ax.barh([str(row.get("feature_name")) for row in rows], [float(row.get("gain") or 0) for row in rows], color="#3274A1")
            ax.set_title("特征重要性")
        elif chart_id == "training_history":
            history = payload if isinstance(payload, Mapping) else {}
            for key, values in history.items():
                if isinstance(values, Mapping):
                    for metric, sequence in values.items():
                        if isinstance(sequence, list):
                            ax.plot(sequence, label=f"{key}:{metric}")
            if ax.lines:
                ax.legend()
            ax.set_title("训练历史")
        elif chart_id == "error_by_horizon":
            rows = payload.get("rows", [])
            ax.plot([str(row.get("end_minute")) for row in rows], [row.get("cvrmse_percent") or float("nan") for row in rows], marker="o")
            ax.set_title("按预测步长的误差")
        elif chart_id == "forecast_summary":
            ax.axis("off")
            ax.text(0.05, 0.85, "\n".join(f"{key}: {value if value is not None else '未提供'}" for key, value in payload.items()), va="top", fontsize=13)
            ax.set_title("预测摘要")
        elif chart_id == "forecast_by_horizon":
            ax.plot(payload.get("horizon_steps", []), payload.get("predictions", []), color="#E67E22")
            ax.set_xlabel("预测步长")
            ax.set_title("按预测步长的预测值")
        elif chart_id == "forecast_threshold":
            ax.text(0.5, 0.5, "未提供阈值，不计算超限", ha="center")
            ax.set_title("预测阈值超限")
        else:
            raise ValueError(f"unsupported chart: {chart_id}")
        fig.tight_layout()
        fig.savefig(path, format="png")
        width, height = fig.canvas.get_width_height()
        plt.close(fig)
        return int(width), int(height)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _bundle_id(source_type: str, source_id: str, source_hash: str) -> str:
    seed = {"skill": "load-forecasting", "source_bundle_type": source_type, "source_bundle_id": source_id, "source_manifest_sha256": source_hash, "renderer_version": "skill4-visual-v1"}
    return f"visualization-skill4-{hashlib.sha256(_canonical(seed)).hexdigest()[:32]}"


def validate_manifest(manifest_path: str | Path) -> dict[str, Any]:
    path = Path(manifest_path).resolve()
    try:
        manifest = _read_json(path)
    except FileNotFoundError as exc:
        raise VisualizationError("MANIFEST_NOT_FOUND", "visualisation manifest does not exist") from exc
    for relative, expected in manifest.get("file_hashes", {}).items():
        target = _safe_file(path.parent, relative)
        if not target.is_file() or sha256_file(target) != expected:
            raise VisualizationError("MANIFEST_HASH_MISMATCH", "visualisation artifact hash mismatch")
    return manifest


def publish_visualizations(bundle_root: str | Path, *, artifact_root: str | Path | None = None, fail_charts: Iterable[str] = ()) -> Path:
    reader = ForecastVisualizationReader()
    inspection = reader.inspect(bundle_root)
    source_hash = sha256_file(inspection["root"] / "manifest.json")
    source_type, source_id = str(inspection["bundle_type"]), str(inspection["bundle_id"])
    bundle_id = _bundle_id(source_type, source_id, source_hash)
    artifact = Path(artifact_root).expanduser().resolve() if artifact_root is not None else inspection["root"].parent.parent
    final = artifact / "visualization-bundles" / bundle_id
    if (final / "manifest.json").is_file():
        validate_manifest(final / "manifest.json")
        return final / "manifest.json"
    payloads = ForecastVisualizationTransformer().transform(inspection)
    renderer = ForecastVisualizationRenderer()
    failed = {str(item) for item in fail_charts}
    chart_ids = EVALUATION_CHART_IDS if source_type == "EvaluationBundle" else FORECAST_CHART_IDS if source_type == "ForecastBundle" else MODEL_CHART_IDS
    final.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".visualization-skill4-", dir=final.parent))
    entries: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    try:
        for order, chart_id in enumerate(chart_ids):
            relative = f"figures/{chart_id}.png"
            if chart_id in failed:
                warning = {"code": "RENDER_FAILED", "message": "图表渲染被调用方标记为失败。", "chart_id": chart_id}
                warnings.append(warning)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning], "display_order": order})
                continue
            if chart_id == "forecast_threshold" and payloads.get(chart_id, {}).get("threshold") is None:
                warning = {"code": "NOT_APPLICABLE", "message": "未提供阈值，不计算预测超限。", "chart_id": chart_id}
                warnings.append(warning)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "not_applicable", "warnings": [warning], "display_order": order})
                continue
            if chart_id == "actual_vs_prediction_scatter":
                paired_count = payloads.get(chart_id, {}).get("paired_count", 0)
                if not isinstance(paired_count, int) or isinstance(paired_count, bool) or paired_count < 2:
                    warning = {
                        "code": "INSUFFICIENT_PAIRED_SAMPLES",
                        "message": "有效 actual/prediction 配对少于 2 个，跳过实际值与预测值散点图。",
                        "chart_id": chart_id,
                        "details": {"paired_count": paired_count if isinstance(paired_count, int) and not isinstance(paired_count, bool) else 0, "minimum_required": 2},
                    }
                    warnings.append(warning)
                    # Do not put a relative path in a non-applicable entry: no
                    # PNG was generated and the manifest must not imply one.
                    entries.append({"chart_id": chart_id, "status": "not_applicable", "warnings": [warning], "display_order": order})
                    continue
            if chart_id in {"actual_vs_prediction", "residual_distribution"}:
                source_values = payloads.get(chart_id, {})
                value_key = "rows" if chart_id == "actual_vs_prediction" else "residual"
                available_values = source_values.get(value_key, []) if isinstance(source_values, Mapping) else []
                if not isinstance(available_values, (list, tuple)) or not available_values:
                    warning = {
                        "code": "INSUFFICIENT_PAIRED_SAMPLES",
                        "message": "没有有效 actual/prediction 配对，跳过依赖评价样本的图表。",
                        "chart_id": chart_id,
                        "details": {"paired_count": 0, "minimum_required": 1},
                    }
                    warnings.append(warning)
                    entries.append({"chart_id": chart_id, "status": "not_applicable", "warnings": [warning], "display_order": order})
                    continue
            reused = inspection.get("reused", {}).get(chart_id) if isinstance(inspection.get("reused", {}), Mapping) else None
            try:
                output = temporary / relative
                if isinstance(reused, Path):
                    output.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(reused, output)
                    width, height = _png_dimensions(output)
                    mode = "reused"
                else:
                    width, height = renderer.render(chart_id, payloads[chart_id], output)
                    mode = "rendered"
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "available", "generation_mode": mode, "mime_type": "image/png", "width_px": width, "height_px": height, "sha256": sha256_file(output), "display_order": order})
            except Exception as exc:
                warning = {"code": getattr(exc, "code", "RENDER_FAILED"), "message": "单图渲染或已有 PNG 校验失败，其他图表仍可用。", "chart_id": chart_id, "details": {"error_type": type(exc).__name__}}
                warnings.append(warning)
                entries.append({"chart_id": chart_id, "relative_path": relative, "status": "failed", "warnings": [warning], "display_order": order})
        warnings.extend(renderer.warnings)
        summary = {"source_bundle_type": source_type, "source_bundle_id": source_id, "chart_count": len(entries), "available_count": sum(item["status"] == "available" for item in entries), "evaluation_metrics": payloads.get("metrics_overview", {}), "forecast_summary": payloads.get("forecast_summary", {})}
        (temporary / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
        file_hashes = {"summary.json": sha256_file(temporary / "summary.json")}
        for entry in entries:
            if entry["status"] == "available":
                file_hashes[entry["relative_path"]] = entry["sha256"]
        incomplete = any(
            item["status"] == "failed"
            or any(
                warning.get("code") == "INSUFFICIENT_PAIRED_SAMPLES"
                for warning in item.get("warnings", [])
                if isinstance(warning, Mapping)
            )
            for item in entries
        )
        manifest = {"bundle_type": "VisualizationBundle", "bundle_version": "1.0", "visualization_bundle_id": bundle_id, "source": {"bundle_type": source_type, "bundle_version": "0.7", "bundle_id": source_id, "manifest_sha256": source_hash}, "renderer_set_version": "skill4-visual-v1", "theme": {"name": "building-energy-default", "version": "1"}, "status": "partial" if incomplete else "succeeded", "figures": entries, "warnings": warnings, "file_hashes": file_hashes}
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


def _png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24:
        raise VisualizationError("PNG_INVALID", "existing evaluation artifact is not a PNG")
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


read_bundle = ForecastVisualizationReader
transform_bundle = ForecastVisualizationTransformer
render_chart = ForecastVisualizationRenderer

__all__ = ["EVALUATION_CHART_IDS", "FORECAST_CHART_IDS", "MODEL_CHART_IDS", "ForecastVisualizationReader", "ForecastVisualizationRenderer", "ForecastVisualizationTransformer", "VisualizationError", "publish_visualizations", "sha256_file", "validate_manifest"]
