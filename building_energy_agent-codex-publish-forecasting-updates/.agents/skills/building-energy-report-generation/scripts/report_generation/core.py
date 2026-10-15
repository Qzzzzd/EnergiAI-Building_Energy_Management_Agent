"""Build a traceable report from public Artifact manifests only.

The module deliberately has no data-science dependency. It treats public
summaries and verified visualization files as immutable evidence and keeps all
report-side derivation limited to presentation formatting.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import math
import os
import re
from io import BytesIO
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


REPORT_ARTIFACT_TYPE = "building-energy.report"
TEMPLATE_VERSION = "report-v4"
RENDERER_VERSION = "python-reportlab-v11"
NARRATIVE_POLICY_VERSION = "narrative-v2"
CHART_REGISTRY_VERSION = "chart-registry-v1"
VISUAL_POLICY_VERSION = "visual-curation-v1"
PDF_BODY_FONT_SIZE = 12
PDF_LATIN_FONT_NAME = "TimesNewRoman"
PDF_LATIN_BOLD_FONT_NAME = "TimesNewRoman-Bold"
PDF_CJK_FONT_NAME = "STSong-Light"
PDF_VISUAL_MAX_HEIGHT_MM = 118
MAX_REPORT_BYTES = 20 * 1024 * 1024
MAX_PDF_BYTES = 20 * 1024 * 1024
MAX_CHARTS = 8
MIN_NARRATIVE_BODY_CHARS = 80
MAX_NARRATIVE_BODY_CHARS = 5_000
MIN_VISUAL_NOTE_CHARS = 24
MAX_VISUAL_NOTE_CHARS = 800
OPAQUE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
NUMBER_TOKEN = re.compile(r"(?<![A-Za-z_])[-+]?\d+(?:\.\d+)?\s*%?")
DISPLAY_ZONE = ZoneInfo("Asia/Shanghai")

REPORT_TYPES = {
    "integrated": "综合分析报告",
    "quality": "数据质量报告",
    "forecast-evaluation": "负荷预测评价报告",
    "forecast-future": "未来负荷预测报告",
}
SOURCE_TYPES = {
    "quality": "QualityAssessmentBundle",
    "processing": "ProcessingBundle",
    "evaluation": "EvaluationBundle",
    "forecast": "ForecastBundle",
}
SOURCE_LABELS = {
    "quality": "数据质量",
    "processing": "数据处理",
    "evaluation": "历史预测评价",
    "forecast": "未来负荷预测",
}
SECTION_SKELETONS = {
    "integrated": [
        ("executive-summary", "执行摘要与关键结论"),
        ("evidence-chain", "数据范围与证据链"),
        ("quality-diagnosis", "数据质量诊断"),
        ("processing-context", "数据处理与可建模性"),
        ("forecast-evaluation", "负荷预测评价"),
        ("future-forecast", "未来负荷预测"),
        ("risks-actions", "风险、限制与行动建议"),
    ],
    "quality": [
        ("executive-summary", "执行摘要"),
        ("evidence-chain", "数据范围"),
        ("quality-diagnosis", "六维质量诊断"),
        ("quality-actions", "关键问题与建议"),
        ("evidence-detail", "证据详情"),
    ],
    "forecast-evaluation": [
        ("executive-summary", "执行摘要"),
        ("evaluation-scope", "评价范围与方法"),
        ("evaluation-metrics", "核心指标"),
        ("horizon-errors", "分预测步长误差与预测对比"),
        ("risks-actions", "风险与适用边界"),
    ],
    "forecast-future": [
        ("executive-summary", "执行摘要"),
        ("future-scope", "预测对象与时间范围"),
        ("future-curve", "未来负荷曲线"),
        ("future-range", "峰值与范围"),
        ("risks-actions", "使用限制与监测建议"),
    ],
}

CHART_REGISTRY = {
    "quality": [
        ("quality", "quality_score_overview"),
        ("quality", "quality_overall_score"),
        ("quality", "issue_severity_counts"),
        ("quality", "issues_by_dimension"),
        ("quality", "affected_scope_summary"),
    ],
    "processing": [
        ("processing", "processed_target_timeline"),
        ("processing", "gap_and_segment_timeline"),
        ("processing", "split_timeline"),
        ("processing", "sample_exclusions"),
        ("processing", "split_sample_counts"),
    ],
    "evaluation": [
        ("evaluation", "metrics_overview"),
        ("evaluation", "actual_vs_prediction"),
        ("evaluation", "actual_vs_prediction_scatter"),
        ("evaluation", "error_by_horizon"),
        ("evaluation", "feature_importance"),
        ("evaluation", "residual_distribution"),
        ("evaluation", "training_history"),
    ],
    "forecast": [
        ("forecast", "forecast_timeseries"),
        ("forecast", "forecast_summary"),
        ("forecast", "forecast_by_horizon"),
        ("forecast", "forecast_threshold"),
    ],
}
# Keep only visuals that answer a reader-facing question.  Single-value or
# text-on-canvas figures are already represented more clearly by the report's
# facts/tables, while dense scatter plots are difficult to read at A4 width.
CHART_SELECTION = {
    "quality": ["quality_score_overview", "issue_severity_counts", "issues_by_dimension"],
    "processing": ["processed_target_timeline", "split_timeline"],
    "evaluation": ["metrics_overview", "actual_vs_prediction", "error_by_horizon"],
    "forecast": ["forecast_timeseries"],
}
CHART_ALIASES = {
    "test_actual_vs_prediction": "actual_vs_prediction",
    "test_actual_vs_prediction_scatter": "actual_vs_prediction_scatter",
    "test_residual_distribution": "residual_distribution",
    "feature_importance_gain_top20": "feature_importance",
    "test_error_by_horizon": "error_by_horizon",
}
CHART_TITLES = {
    "quality_score_overview": "六维质量评分",
    "quality_overall_score": "综合质量评分",
    "issue_severity_counts": "质量问题严重性分布",
    "issues_by_dimension": "质量问题按维度分布",
    "affected_scope_summary": "受影响范围摘要",
    "processed_target_timeline": "处理后目标曲线",
    "gap_and_segment_timeline": "缺口与分段",
    "split_timeline": "样本时间切分",
    "sample_exclusions": "样本排除原因",
    "split_sample_counts": "各阶段样本数量",
    "metrics_overview": "模型评价指标",
    "actual_vs_prediction": "实际值与预测值对比",
    "actual_vs_prediction_scatter": "实际值与预测值散点",
    "error_by_horizon": "按预测步长的误差",
    "feature_importance": "特征重要性",
    "residual_distribution": "残差分布",
    "training_history": "训练历史",
    "forecast_timeseries": "未来负荷预测",
    "forecast_summary": "预测摘要",
    "forecast_by_horizon": "按预测步长的预测值",
    "forecast_threshold": "预测阈值超限",
}
DIMENSION_TITLES = {
    "DQ1": "完整性",
    "DQ2": "准确性",
    "DQ3": "全面性",
    "DQ4": "值域覆盖",
    "DQ5": "一致性",
    "DQ6": "信息熵",
}
TABLE_REFS = {
    "integrated": {
        "来源证据清单",
        "关键事实",
        "处理上下文",
        "分区样本数量",
        "评价指标",
        "测试集分预测步长指标",
        "预测样例（公开预览）",
        "风险与限制",
    },
    "quality": {"来源证据清单", "关键事实", "六维质量结果", "质量问题与行动建议", "重点问题", "质量来源元数据"},
    "forecast-evaluation": {"关键事实", "评价指标", "测试集分预测步长指标", "风险与限制"},
    "forecast-future": {"关键事实", "预测样例（公开预览）", "风险与限制"},
}


class ReportFailure(RuntimeError):
    """A user-safe, deterministic report validation or rendering failure."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


@dataclass(frozen=True)
class SourceFile:
    path: Path
    role: str
    media_type: str
    relative_path: str
    sha256: str
    size_bytes: int
    chart_id: str | None = None
    chart_title: str | None = None


@dataclass(frozen=True)
class SourceArtifact:
    key: str
    artifact_id: str
    artifact_type: str
    status: str
    root: Path
    manifest_path: Path
    manifest: dict[str, Any]
    summary: dict[str, Any]
    native: dict[str, Any]
    files: tuple[SourceFile, ...]
    manifest_sha256: str

    @property
    def source_ids(self) -> tuple[str, ...]:
        return tuple(item for item in self.manifest.get("source_ids", []) if isinstance(item, str))

    @property
    def warnings(self) -> tuple[str, ...]:
        return tuple(item for item in self.manifest.get("warnings", []) if isinstance(item, str))

    def role_file(self, role: str) -> SourceFile | None:
        return next((item for item in self.files if item.role == role), None)

    def json_role(self, role: str, default: Any = None) -> Any:
        item = self.role_file(role)
        if item is None:
            return default
        try:
            value = json.loads(item.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ReportFailure("ARTIFACT_INTEGRITY_FAILED", f"公开证据文件无法读取：{item.relative_path}") from exc
        return value

    @property
    def visualizations(self) -> tuple[SourceFile, ...]:
        return tuple(item for item in self.files if item.role == "visualization")


def _nowhere(value: Any) -> Any:
    """Return JSON-compatible values without copying arbitrary source payloads."""

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, list):
        return [_nowhere(item) for item in value[:200]]
    if isinstance(value, dict):
        return {str(key): _nowhere(item) for key, item in list(value.items())[:200]}
    return str(value)


def _unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value[:2_000])
    return result


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def _atomic_bytes(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    _atomic_bytes(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False).encode("utf-8") + b"\n")


def _safe_relative(value: Any) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value or "\x00" in value:
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件路径不是安全的相对路径。")
    parts = value.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件路径包含非法片段。")
    return value


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _read_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"无法读取 {label}。") from exc
    if not isinstance(value, dict):
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"{label} 必须是 JSON 对象。")
    return value


def _visual_descriptor(summary: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    values = summary.get("visualizations")
    if not isinstance(values, list):
        return result
    for value in values:
        if not isinstance(value, dict):
            continue
        chart_id = value.get("chart_id")
        title = value.get("title")
        if isinstance(chart_id, str) and isinstance(title, str) and title:
            result[chart_id] = title
    return result


def _canonical_chart_id(value: str) -> str:
    stem = Path(value).stem
    if stem in CHART_ALIASES:
        return CHART_ALIASES[stem]
    for alias, canonical in CHART_ALIASES.items():
        if stem.startswith(alias + "_"):
            return canonical
    return stem


def load_source(artifact_root: Path, key: str, artifact_id: str) -> SourceArtifact:
    if key not in SOURCE_TYPES:
        raise ReportFailure("VALIDATION_ERROR", f"不支持的来源类别：{key}。")
    if not isinstance(artifact_id, str) or not OPAQUE_ID.fullmatch(artifact_id):
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"{key} Artifact ID 无效。")
    root = artifact_root.resolve(strict=True)
    manifest_path = (root / "public-artifacts" / artifact_id / "manifest.json").resolve()
    if not _inside(manifest_path, root) or not manifest_path.is_file():
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"未找到公开 Artifact：{artifact_id}。")
    manifest = _read_object(manifest_path, f"Artifact {artifact_id} manifest")
    if manifest.get("artifact_id") != artifact_id:
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact ID 与 manifest 不一致。")
    if manifest.get("artifact_type") != SOURCE_TYPES[key]:
        raise ReportFailure(
            "SOURCE_TYPE_MISMATCH",
            f"来源 {artifact_id} 不是 {SOURCE_TYPES[key]}。",
            {"expected": SOURCE_TYPES[key], "actual": manifest.get("artifact_type")},
        )
    status = manifest.get("status")
    if status not in {"succeeded", "partial"}:
        raise ReportFailure("SOURCE_STATUS_INVALID", f"来源 {artifact_id} 的状态不可作为报告事实。")
    summary = manifest.get("summary")
    if not isinstance(summary, dict):
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"来源 {artifact_id} 缺少公开摘要。")
    raw_files = manifest.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"来源 {artifact_id} 没有公开文件。")
    descriptors = _visual_descriptor(summary)
    files: list[SourceFile] = []
    for raw in raw_files:
        if not isinstance(raw, dict):
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件条目无效。")
        relative = _safe_relative(raw.get("relative_path"))
        media_type = raw.get("media_type")
        role = raw.get("role")
        expected_size = raw.get("size_bytes")
        expected_sha = raw.get("sha256")
        if not isinstance(media_type, str) or not isinstance(role, str) or not role:
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件缺少 MIME 或 role。")
        if not isinstance(expected_size, int) or isinstance(expected_size, bool) or expected_size < 0:
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件大小无效。")
        if not isinstance(expected_sha, str) or not SHA256.fullmatch(expected_sha):
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact 文件哈希无效。")
        file_path = (root / relative).resolve()
        if not _inside(file_path, root) or not file_path.is_file():
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"公开文件不存在：{relative}。")
        actual_size = file_path.stat().st_size
        actual_sha = _sha256_file(file_path)
        if actual_size != expected_size or actual_sha != expected_sha:
            raise ReportFailure("ARTIFACT_INTEGRITY_FAILED", f"公开文件完整性校验失败：{relative}。")
        chart_id = None
        chart_title = None
        if role == "visualization":
            if media_type.split(";", 1)[0].lower() != "image/png" or file_path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
                raise ReportFailure("ARTIFACT_INTEGRITY_FAILED", f"可视化文件不是有效 PNG：{relative}。")
            chart_id = _canonical_chart_id(Path(relative).stem)
            chart_title = descriptors.get(chart_id) or descriptors.get(Path(relative).stem) or CHART_TITLES.get(chart_id)
        files.append(SourceFile(file_path, role, media_type, relative, actual_sha, actual_size, chart_id, chart_title))
    source_ids = manifest.get("source_ids", [])
    if not isinstance(source_ids, list) or any(not isinstance(item, str) or not OPAQUE_ID.fullmatch(item) for item in source_ids):
        raise ReportFailure("ARTIFACT_REFERENCE_INVALID", "Artifact source_ids 无效。")
    native: dict[str, Any] = {}
    native_file = next((item for item in files if item.role == "native-manifest"), None)
    if native_file is not None:
        native = _read_object(native_file.path, f"Artifact {artifact_id} native-manifest")
    return SourceArtifact(
        key=key,
        artifact_id=artifact_id,
        artifact_type=str(manifest["artifact_type"]),
        status=status,
        root=root,
        manifest_path=manifest_path,
        manifest=manifest,
        summary=summary,
        native=native,
        files=tuple(files),
        manifest_sha256=_sha256_file(manifest_path),
    )


def _str_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _dataset_id(source: SourceArtifact) -> str | None:
    return _str_value(source.native.get("source_bundle_id")) or _str_value(source.native.get("dataset_bundle_id")) or _str_value(source.summary.get("source_bundle_id"))


def _target_id(source: SourceArtifact) -> str | None:
    return _str_value(source.summary.get("target_point_id")) or _str_value(source.summary.get("source_target_point_id")) or _str_value(source.native.get("target_point_id"))


def _processing_id(source: SourceArtifact) -> str | None:
    return _str_value(source.native.get("processing_bundle_id"))


def _model_id(source: SourceArtifact) -> str | None:
    return _str_value(source.native.get("model_bundle_id"))


def _mode(source: SourceArtifact) -> str | None:
    return _str_value(source.summary.get("mode")) or _str_value(source.native.get("processing_mode"))


def _feature_fingerprint(source: SourceArtifact) -> str | None:
    return _str_value(source.native.get("feature_schema_fingerprint"))


def _leakage_rule(source: SourceArtifact) -> str | None:
    return _str_value(source.native.get("leakage_check_rule_version"))


def _required_keys(report_type: str) -> list[str]:
    if report_type == "quality":
        return ["quality"]
    if report_type == "forecast-evaluation":
        return ["evaluation"]
    if report_type == "forecast-future":
        return ["forecast"]
    return ["quality"]


def _normalize_request(request: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(request, dict):
        raise ReportFailure("VALIDATION_ERROR", "报告请求必须是 JSON 对象。")
    allowed = {"report_type", "title", "source_artifact_ids", "narrative_blocks", "report_config"}
    unexpected = sorted(set(request) - allowed)
    if unexpected:
        raise ReportFailure("VALIDATION_ERROR", f"报告请求包含未注册字段：{', '.join(unexpected)}。")
    report_type = request.get("report_type")
    if report_type not in REPORT_TYPES:
        raise ReportFailure("VALIDATION_ERROR", "report_type 必须是四种固定报告类型之一。")
    title = request.get("title")
    if title is not None and (not isinstance(title, str) or len(title.strip()) > 200):
        raise ReportFailure("VALIDATION_ERROR", "报告标题必须是 200 字以内文本。")
    raw_ids = request.get("source_artifact_ids", {})
    if not isinstance(raw_ids, dict):
        raise ReportFailure("VALIDATION_ERROR", "source_artifact_ids 必须是对象。")
    if set(raw_ids) - set(SOURCE_TYPES):
        raise ReportFailure("VALIDATION_ERROR", "source_artifact_ids 包含未注册来源类别。")
    source_ids: dict[str, str] = {}
    for key, value in raw_ids.items():
        if value is None or value == "":
            continue
        if not isinstance(value, str) or not OPAQUE_ID.fullmatch(value):
            raise ReportFailure("ARTIFACT_REFERENCE_INVALID", f"{key} Artifact ID 无效。")
        source_ids[key] = value
    missing = [key for key in _required_keys(report_type) if key not in source_ids]
    if report_type == "integrated" and "evaluation" not in source_ids and "forecast" not in source_ids:
        missing.append("evaluation 或 forecast")
    narrative_blocks = request.get("narrative_blocks", [])
    if not isinstance(narrative_blocks, list) or len(narrative_blocks) > 64:
        raise ReportFailure("VALIDATION_ERROR", "narrative_blocks 必须是不超过 64 项的数组。")
    report_config = request.get("report_config", {})
    if not isinstance(report_config, dict):
        raise ReportFailure("VALIDATION_ERROR", "report_config 必须是对象。")
    allowed_config = {"template_version", "renderer_version", "chart_registry_version"}
    if set(report_config) - allowed_config:
        raise ReportFailure("VALIDATION_ERROR", "report_config 只允许版本字段。")
    for key, value in report_config.items():
        if not isinstance(value, str) or not value or len(value) > 128:
            raise ReportFailure("VALIDATION_ERROR", f"report_config.{key} 无效。")
    current_versions = {
        "template_version": TEMPLATE_VERSION,
        "renderer_version": RENDERER_VERSION,
        "chart_registry_version": CHART_REGISTRY_VERSION,
    }
    for key, value in report_config.items():
        if value != current_versions[key]:
            raise ReportFailure("VALIDATION_ERROR", f"report_config.{key} 不是当前注册版本。")
    normalized = {
        "report_type": report_type,
        "title": title.strip() if isinstance(title, str) and title.strip() else None,
        "source_artifact_ids": source_ids,
        "narrative_blocks": narrative_blocks,
        "report_config": {
            "template_version": TEMPLATE_VERSION,
            "renderer_version": RENDERER_VERSION,
            "chart_registry_version": CHART_REGISTRY_VERSION,
        },
    }
    return normalized, missing


def _compatibility(sources: dict[str, SourceArtifact], report_type: str) -> list[str]:
    warnings: list[str] = []
    for key, source in sources.items():
        warnings.extend(f"{SOURCE_LABELS[key]}来源：{warning}" for warning in source.warnings)
        if source.status == "partial":
            warnings.append(f"{SOURCE_LABELS[key]}来源状态为 partial，报告继承该状态。")
    for key, expected_mode in (("evaluation", "backtest"), ("forecast", "future")):
        source = sources.get(key)
        if source is not None and _mode(source) not in {expected_mode, None}:
            raise ReportFailure("SOURCE_INCONSISTENT", f"{SOURCE_LABELS[key]}来源的模式不是 {expected_mode}。")

    dataset_values = {value for value in (_dataset_id(source) for source in sources.values()) if value}
    if len(dataset_values) > 1:
        raise ReportFailure("SOURCE_INCONSISTENT", "来源之间的 DatasetBundle 不一致。")
    targets = {value for value in (_target_id(source) for source in sources.values()) if value}
    if len(targets) > 1:
        raise ReportFailure("SOURCE_INCONSISTENT", "来源之间的目标点位不一致。")
    models = {value for value in (_model_id(sources[key]) for key in ("evaluation", "forecast") if key in sources) if value}
    if len(models) > 1:
        raise ReportFailure("SOURCE_INCONSISTENT", "历史评价与未来预测使用的模型链不一致。")

    processing = sources.get("processing")
    if processing is not None:
        processing_id = _str_value(processing.native.get("processing_bundle_id"))
        for key in ("evaluation", "forecast"):
            source = sources.get(key)
            linked = _processing_id(source) if source is not None else None
            if linked and processing_id and linked != processing_id:
                warnings.append(f"{SOURCE_LABELS[key]}与提供的处理来源不是同一个 ProcessingBundle。")
                if report_type != key and report_type != "integrated":
                    raise ReportFailure("SOURCE_INCONSISTENT", "处理来源与预测来源的 Bundle 链不一致。")
    if report_type == "integrated":
        has_quality = "quality" in sources
        has_model_result = "evaluation" in sources or "forecast" in sources
        if has_quality and has_model_result and len(dataset_values) == 0:
            warnings.append("未从公开来源确认综合报告的 DatasetBundle 链，质量与预测章节仅作独立证据展示。")
        if "evaluation" in sources and "forecast" in sources:
            eval_feature = _feature_fingerprint(sources["evaluation"])
            future_feature = _feature_fingerprint(sources["forecast"])
            if eval_feature and future_feature and eval_feature != future_feature:
                warnings.append("历史评价与未来预测未公开相同的特征模式指纹，不能形成完整联合结论。")
            eval_rule = _leakage_rule(sources["evaluation"])
            future_rule = _leakage_rule(sources["forecast"])
            if eval_rule and future_rule and eval_rule != future_rule:
                warnings.append("历史评价与未来预测的泄漏检查规则版本不同。")
    return _unique(warnings)


def _format_number(value: Any, digits: int = 2) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return "未提供"
    return f"{float(value):,.{digits}f}"


def _format_percent(value: Any, *, ratio: bool = False, digits: int = 2) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return "未提供"
    number = float(value) * 100 if ratio else float(value)
    return f"{number:.{digits}f}%"


def _format_time(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return "未提供"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is None:
        return value
    return parsed.astimezone(DISPLAY_ZONE).isoformat(timespec="minutes")


def _time_range(summary: dict[str, Any]) -> tuple[str, str]:
    scope = summary.get("effective_scope")
    if isinstance(scope, dict):
        return str(scope.get("time_start") or ""), str(scope.get("time_end") or "")
    time_range = summary.get("time_range")
    if isinstance(time_range, dict):
        return str(time_range.get("time_start") or ""), str(time_range.get("time_end") or "")
    return str(summary.get("start_at") or ""), str(summary.get("end_at") or "")


def build_facts(sources: dict[str, SourceArtifact]) -> dict[str, Any]:
    facts: dict[str, Any] = {}
    quality = sources.get("quality")
    if quality is not None:
        dimensions = quality.summary.get("dimensions")
        dim_rows = []
        if isinstance(dimensions, dict):
            for dimension_id, value in dimensions.items():
                if not isinstance(value, dict):
                    continue
                dim_rows.append(
                    {
                        "id": str(dimension_id),
                        "name": DIMENSION_TITLES.get(str(dimension_id), str(dimension_id)),
                        "status": value.get("status"),
                        "score": value.get("score"),
                        "summary": value.get("summary"),
                    }
                )
        issues = quality.summary.get("issues")
        facts["quality"] = {
            "overall_score": quality.summary.get("overall_score"),
            "conclusion": quality.summary.get("conclusion"),
            "dimensions": dim_rows[:6],
            "issues": _nowhere(issues[:50] if isinstance(issues, list) else []),
            "effective_scope": _nowhere(quality.summary.get("effective_scope", {})),
        }
    processing = sources.get("processing")
    if processing is not None:
        split_counts = processing.summary.get("split_sample_counts")
        facts["processing"] = {
            "mode": processing.summary.get("mode") or processing.native.get("processing_mode"),
            "source_bundle_id": _dataset_id(processing),
            "target_point_id": _target_id(processing),
            "horizon_minutes": processing.summary.get("horizon_minutes"),
            "feature_rule_version": processing.summary.get("feature_rule_version") or processing.native.get("processing_rule_version"),
            "data_granularity": processing.native.get("data_granularity"),
            "leakage_check_rule_version": processing.native.get("leakage_check_rule_version"),
            "leakage_check_status": processing.native.get("leakage_check_status"),
            "split_sample_counts": _nowhere(split_counts if isinstance(split_counts, dict) else {}),
            "forecast_start": processing.summary.get("forecast_start"),
            "forecast_end": processing.summary.get("forecast_end"),
        }
    evaluation = sources.get("evaluation")
    if evaluation is not None:
        metrics = evaluation.summary.get("metrics")
        facts["evaluation"] = {
            "mode": evaluation.summary.get("mode"),
            "target_point_id": evaluation.summary.get("target_point_id"),
            "timezone": evaluation.summary.get("timezone"),
            "horizon_hours": evaluation.summary.get("horizon_hours"),
            "start_at": evaluation.summary.get("start_at"),
            "end_at": evaluation.summary.get("end_at"),
            "metrics": _nowhere(metrics if isinstance(metrics, dict) else {}),
        }
    forecast = sources.get("forecast")
    if forecast is not None:
        preview = forecast.json_role("forecast-preview", [])
        facts["forecast"] = {
            "mode": forecast.summary.get("mode"),
            "target_point_id": forecast.summary.get("target_point_id"),
            "timezone": forecast.summary.get("timezone"),
            "horizon_hours": forecast.summary.get("horizon_hours"),
            "start_at": forecast.summary.get("start_at"),
            "end_at": forecast.summary.get("end_at"),
            "prediction_summary": _nowhere(forecast.summary.get("prediction_summary", {})),
            "preview": _nowhere(preview[:24] if isinstance(preview, list) else []),
        }
    return facts


def _section_source_keys(
    report_type: str, section_id: str, sources: dict[str, SourceArtifact]
) -> list[str]:
    all_keys = list(sources)
    mapping: dict[str, list[str]] = {
        "executive-summary": all_keys,
        "evidence-chain": all_keys,
        "quality-diagnosis": ["quality"],
        "quality-actions": ["quality"],
        "evidence-detail": ["quality"],
        "processing-context": ["processing"],
        "evaluation-scope": ["evaluation"],
        "evaluation-metrics": ["evaluation"],
        "horizon-errors": ["evaluation"],
        "future-scope": ["forecast"],
        "future-curve": ["forecast"],
        "future-range": ["forecast"],
        "risks-actions": all_keys,
    }
    return [key for key in mapping.get(section_id, all_keys) if key in sources]


def _narrative_char_count(value: Any) -> int:
    if not isinstance(value, str):
        return 0
    return len("".join(value.split()))


def _narrative_texts(value: dict[str, Any]) -> list[str]:
    texts = [value.get("takeaway", ""), value.get("body", ""), value.get("next_action", "")]
    caveats = value.get("caveats", [])
    if isinstance(caveats, list):
        texts.extend(caveat for caveat in caveats if isinstance(caveat, str))
    return [text for text in texts if isinstance(text, str) and text]


def _numeric_variants(value: Any) -> set[str]:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
        return set()
    number = float(value)
    variants = {str(value), f"{number:g}"}
    for places in (2, 3, 4):
        variants.update(
            {
                f"{number:.{places}f}",
                f"{number:,.{places}f}",
                f"{number:.{places}f}%",
                f"{number:,.{places}f}%",
                f"{number * 100:.{places}f}%",
                f"{number * 100:,.{places}f}%",
            }
        )
    variants.update({f"{number * 100:.0f}%", f"{number * 100:,.0f}%"})
    return variants


def _fact_numeric_literals(value: Any) -> set[str]:
    literals: set[str] = set()
    if isinstance(value, dict):
        for item in value.values():
            literals.update(_fact_numeric_literals(item))
    elif isinstance(value, list):
        for item in value:
            literals.update(_fact_numeric_literals(item))
    else:
        literals.update(_numeric_variants(value))
    return literals


def _numeric_claims_bound(texts: list[str], cited_facts: dict[str, Any]) -> bool:
    serialized = _json_bytes(cited_facts).decode("utf-8").replace(",", "")
    literals = {item.replace(",", "") for item in _fact_numeric_literals(cited_facts)}
    for text in texts:
        for match in NUMBER_TOKEN.finditer(text):
            token = match.group(0).replace(" ", "").replace(",", "")
            if token in serialized or token in literals:
                continue
            return False
    return True


def _validate_visual_notes(
    raw_notes: Any,
    report_type: str,
    valid_chart_refs: set[str],
) -> list[dict[str, str]] | None:
    if raw_notes is None:
        return []
    if not isinstance(raw_notes, list) or len(raw_notes) > 32:
        return None
    accepted: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for raw in raw_notes:
        if not isinstance(raw, dict):
            return None
        kind = raw.get("kind")
        ref = raw.get("ref")
        text = raw.get("text")
        if kind not in {"chart", "table"} or not isinstance(ref, str) or not isinstance(text, str):
            return None
        if kind == "chart" and ref not in valid_chart_refs:
            if ref in CHART_TITLES:
                continue
            return None
        if kind == "table" and ref not in TABLE_REFS[report_type]:
            return None
        if _narrative_char_count(text) < MIN_VISUAL_NOTE_CHARS:
            return None
        key = (kind, ref)
        if key in seen:
            return None
        seen.add(key)
        accepted.append({"kind": kind, "ref": ref, "text": text[:MAX_VISUAL_NOTE_CHARS]})
    return accepted


def _validate_narratives(
    raw_blocks: list[Any],
    report_type: str,
    sources: dict[str, SourceArtifact],
    facts: dict[str, Any],
    charts: list[SourceFile],
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    valid_sections = {item[0] for item in SECTION_SKELETONS[report_type]}
    valid_artifact_refs = {source.artifact_id for source in sources.values()}
    valid_fact_refs = {f"fact:{key}" for key in facts}
    valid_chart_refs = {chart.chart_id for chart in charts if chart.chart_id}
    known_chart_refs = set(CHART_TITLES)
    accepted: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    for index, raw in enumerate(raw_blocks):
        if not isinstance(raw, dict):
            warnings.append(f"叙事块 {index + 1} 不是对象，已回退确定性模板。")
            continue
        section_id = raw.get("section_id")
        takeaway = raw.get("takeaway")
        body = raw.get("body")
        evidence_refs = raw.get("evidence_refs", [])
        fact_refs = raw.get("fact_refs", [])
        chart_refs = raw.get("chart_refs", [])
        if section_id not in valid_sections or not isinstance(takeaway, str) or not isinstance(body, str):
            warnings.append(f"叙事块 {index + 1} 缺少固定章节或文本字段，已回退确定性模板。")
            continue
        if section_id in accepted:
            warnings.append(f"叙事块 {index + 1} 重复覆盖章节 {section_id}，已回退确定性模板。")
            continue
        expected_sources = _section_source_keys(report_type, section_id, sources)
        if not expected_sources:
            warnings.append(f"叙事块 {index + 1} 对应章节没有可验证来源，已拒绝。")
            continue
        if not isinstance(evidence_refs, list) or not evidence_refs or any(item not in valid_artifact_refs for item in evidence_refs):
            warnings.append(f"叙事块 {index + 1} 缺少有效证据引用，已回退确定性模板。")
            continue
        expected_artifacts = {sources[key].artifact_id for key in expected_sources}
        if not any(item in expected_artifacts for item in evidence_refs):
            warnings.append(f"叙事块 {index + 1} 的证据未覆盖章节来源，已回退确定性模板。")
            continue
        if (
            not isinstance(fact_refs, list)
            or not fact_refs
            or any(not isinstance(item, str) or item not in valid_fact_refs for item in fact_refs)
            or not any(item == f"fact:{key}" for item in fact_refs for key in expected_sources)
        ):
            warnings.append(f"叙事块 {index + 1} 的事实引用无效或未覆盖章节来源，已回退确定性模板。")
            continue
        if not isinstance(chart_refs, list) or any(not isinstance(item, str) for item in chart_refs):
            warnings.append(f"叙事块 {index + 1} 引用了未选中的图表，已回退确定性模板。")
            continue
        if any(item not in known_chart_refs for item in chart_refs):
            warnings.append(f"叙事块 {index + 1} 引用了未选中的图表，已回退确定性模板。")
            continue
        chart_refs = [item for item in chart_refs if item in valid_chart_refs]
        body_length = _narrative_char_count(body)
        if body_length < MIN_NARRATIVE_BODY_CHARS or body_length > MAX_NARRATIVE_BODY_CHARS:
            warnings.append(f"叙事块 {index + 1} 正文长度不符合专业报告要求，已回退确定性模板。")
            continue
        caveats = raw.get("caveats", [])
        if not isinstance(caveats, list) or any(not isinstance(item, str) for item in caveats):
            warnings.append(f"叙事块 {index + 1} 的限制说明无效，已回退确定性模板。")
            continue
        visual_notes = _validate_visual_notes(raw.get("visual_notes"), report_type, valid_chart_refs)
        if visual_notes is None:
            warnings.append(f"叙事块 {index + 1} 的图表/表格解读引用无效，已回退确定性模板。")
            continue
        cited_facts = {key[5:]: facts[key[5:]] for key in fact_refs if key.startswith("fact:")}
        text_values = [takeaway, body, str(raw.get("next_action") or ""), *caveats]
        text_values.extend(note["text"] for note in visual_notes)
        if not _numeric_claims_bound(text_values, cited_facts):
            warnings.append(f"叙事块 {index + 1} 含有未被事实引用覆盖的数字，已拒绝。")
            continue
        accepted[section_id] = {
            "takeaway": takeaway[:500],
            "body": body[:MAX_NARRATIVE_BODY_CHARS],
            "caveats": [item[:500] for item in caveats[:8]],
            "next_action": str(raw.get("next_action") or "")[:500],
            "evidence_refs": [str(item) for item in evidence_refs[:16]],
            "fact_refs": [str(item) for item in fact_refs[:16]],
            "chart_refs": chart_refs[:16],
            "visual_notes": visual_notes,
            "origin": "codex",
        }
    return accepted, _unique(warnings)


def _fallback_chart_refs(section_id: str, charts: list[SourceFile]) -> list[str]:
    preferred = {
        "quality-diagnosis": {"quality_score_overview", "quality_overall_score", "issue_severity_counts", "issues_by_dimension"},
        "quality-actions": {"affected_scope_summary"},
        "processing-context": {"processed_target_timeline", "gap_and_segment_timeline", "split_timeline", "split_sample_counts"},
        "evaluation-metrics": {"metrics_overview", "actual_vs_prediction", "actual_vs_prediction_scatter"},
        "horizon-errors": {"error_by_horizon", "actual_vs_prediction"},
        "forecast-evaluation": {"metrics_overview", "actual_vs_prediction", "error_by_horizon"},
        "future-forecast": {"forecast_timeseries", "forecast_summary", "forecast_by_horizon"},
        "future-curve": {"forecast_timeseries", "forecast_summary", "forecast_by_horizon"},
        "future-range": {"forecast_threshold"},
    }.get(section_id, set())
    return [chart.chart_id for chart in charts if chart.chart_id in preferred]


def _fallback_narrative(
    section_id: str,
    source_keys: list[str],
    sources: dict[str, SourceArtifact],
    facts: dict[str, Any],
    charts: list[SourceFile],
    takeaway: str,
    body: str,
    *,
    next_action: str = "",
    caveats: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "takeaway": takeaway,
        "body": body,
        "next_action": next_action,
        "caveats": caveats or [],
        "evidence_refs": [sources[key].artifact_id for key in source_keys],
        "fact_refs": [f"fact:{key}" for key in source_keys if key in facts],
        "chart_refs": _fallback_chart_refs(section_id, charts),
        "visual_notes": [],
        "origin": "deterministic-fallback",
    }


def _fallback_narratives(
    report_type: str,
    sources: dict[str, SourceArtifact],
    facts: dict[str, Any],
    charts: list[SourceFile],
    warnings: list[str],
) -> dict[str, dict[str, Any]]:
    quality = facts.get("quality", {})
    processing = facts.get("processing", {})
    evaluation = facts.get("evaluation", {})
    forecast = facts.get("forecast", {})
    metrics = evaluation.get("metrics", {}) if isinstance(evaluation.get("metrics"), dict) else {}
    test = metrics.get("test", {}) if isinstance(metrics.get("test"), dict) else {}
    validation = metrics.get("validation", {}) if isinstance(metrics.get("validation"), dict) else {}
    issues = quality.get("issues", []) if isinstance(quality.get("issues"), list) else []
    dimensions = quality.get("dimensions", []) if isinstance(quality.get("dimensions"), list) else []
    scored_dimensions = [item for item in dimensions if isinstance(item, dict) and isinstance(item.get("score"), (int, float))]
    lowest = min(scored_dimensions, key=lambda item: float(item["score"])) if scored_dimensions else None
    highest = max(scored_dimensions, key=lambda item: float(item["score"])) if scored_dimensions else None
    first_issue = issues[0] if issues and isinstance(issues[0], dict) else {}
    prediction_summary = forecast.get("prediction_summary", {}) if isinstance(forecast.get("prediction_summary"), dict) else {}
    output: dict[str, dict[str, Any]] = {}

    for section_id, _ in SECTION_SKELETONS[report_type]:
        source_keys = _section_source_keys(report_type, section_id, sources)
        if not source_keys:
            continue
        labels = "、".join(SOURCE_LABELS[key] for key in source_keys)
        if section_id == "executive-summary":
            takeaway_parts: list[str] = []
            if quality.get("overall_score") is not None:
                takeaway_parts.append(f"数据质量综合评分为 {_format_number(quality.get('overall_score'))} 分。")
            if test.get("cvrmse_percent") is not None:
                takeaway_parts.append(f"历史测试集 CVRMSE 为 {_format_percent(test.get('cvrmse_percent'))}。")
            if forecast:
                takeaway_parts.append(f"未来预测公开样本数为 {prediction_summary.get('prediction_count', '未提供')}。")
            takeaway = "".join(takeaway_parts) or "当前来源已完成公开校验，但暂未形成数值化结论。"
            body = (
                f"本节将{labels}作为相互关联但不等价的证据层呈现。质量结果用于判断输入可信度，"
                "历史评价用于观察模型在已知标签上的表现，未来预测只描述待发生时段的输出范围。"
                "这些结果均来自已登记 Artifact，报告生成阶段不重算指标，也不把相关性或时间上的并列关系解释成因果关系。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action="优先处理来源中标记为 critical 或 warning 的问题，再结合评价边界决定预测结果的使用范围。",
            )
        elif section_id == "evidence-chain":
            ranges = []
            for key in source_keys:
                start, end = _time_range(sources[key].summary)
                ranges.append(f"{SOURCE_LABELS[key]}为 {_format_time(start)} 至 {_format_time(end)}")
            body = (
                f"本报告引用 {len(source_keys)} 个已登记公开 Artifact，来源时间范围分别为：{'；'.join(ranges)}。"
                "来源之间只有在 DatasetBundle、目标点位、ProcessingBundle 和模型链等公开元数据能够对应时，"
                "才形成联合证据；无法证明一致的结果将保持章节独立，并在限制中明确说明。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                "证据链可追溯，但不同来源的可比性必须以公开链路为准。",
                body,
                caveats=["时间范围、目标点位和 Bundle 链不完整时，不扩写跨来源结论。"],
            )
        elif section_id == "quality-diagnosis":
            score_text = _format_number(quality.get("overall_score"))
            low_text = "未提供"
            high_text = "未提供"
            if lowest:
                low_text = f"{lowest.get('name', lowest.get('id'))} {_format_number(lowest.get('score'))} 分"
            if highest:
                high_text = f"{highest.get('name', highest.get('id'))} {_format_number(highest.get('score'))} 分"
            takeaway = f"六维质量表现并不均衡，综合评分为 {score_text} 分，当前最低维度为 {low_text}。"
            body = (
                f"公开摘要显示，六维结果中最高维度为 {high_text}，最低维度为 {low_text}；问题清单共 {len(issues)} 项。"
                "这说明后续治理不能只看综合分，还应结合低分维度、问题严重性和受影响范围安排优先级。"
                "这里的解释仅描述质量证据所支持的治理重点，不替代设备协议、BMS 数据字典或运行日志。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action="先核对低分维度对应的问题证据，再保留原始值和质量标记重新执行质量评估。",
            )
        elif section_id == "quality-actions":
            issue_summary = str(first_issue.get("summary") or "未提供具体问题")
            action = str(first_issue.get("recommended_action") or "按来源建议核查")
            severity = str(first_issue.get("severity") or "未提供")
            takeaway = f"问题清单共 {len(issues)} 项，应先处理严重性为 {severity} 的首项问题。"
            body = (
                f"当前公开问题中，优先项为“{issue_summary}”，来源建议为“{action}”。"
                "问题排序只表示治理优先级，不代表报告已经证明了设备故障或能耗原因。"
                "执行处理时应保留原始值、处理标记和复核记录，完成后再用新的质量 Artifact 验证问题是否真正改善。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action=action,
            )
        elif section_id == "evidence-detail":
            quality_source = sources.get("quality")
            formula = str(quality_source.native.get("formula_version") or "未提供") if quality_source else "未提供"
            body = (
                f"本节用于复核质量来源的 Artifact 身份、DatasetBundle 和公式版本；当前公式版本为 {formula}。"
                "这些元数据用于说明结论从哪里来，不代表报告阶段重新抽样、重算评分或验证了未公开的底层记录。"
                "当来源版本或数据范围发生变化时，应重新生成报告并重新检查证据链。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                "质量结论可以追溯到来源元数据，但不应脱离来源版本单独使用。",
                body,
            )
        elif section_id == "processing-context":
            mode = str(processing.get("mode") or "未提供")
            leakage = str(processing.get("leakage_check_status") or "未提供")
            horizon = _format_number(processing.get("horizon_minutes"))
            takeaway = f"处理来源模式为 {mode}，公开泄漏检查状态为 {leakage}。"
            body = (
                f"公开 ProcessingBundle 表明当前处理链的预测跨度为 {horizon} 分钟，目标点位为 {processing.get('target_point_id') or '未提供'}。"
                "这些元数据支持判断处理结果属于哪一类建模上下文，并帮助检查预测评价和未来预测是否使用了可对应的处理链。"
                "泄漏检查通过也不等于预测效果已经得到保证，模型表现仍应回到 EvaluationBundle 的公开指标。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action="在使用预测结果前，先确认目标点位、处理 Bundle 和特征规则与当前任务一致。",
            )
        elif section_id in {"evaluation-scope", "forecast-evaluation"}:
            start = _format_time(evaluation.get("start_at"))
            end = _format_time(evaluation.get("end_at"))
            horizon = _format_number(evaluation.get("horizon_hours"))
            if section_id == "evaluation-scope":
                takeaway = f"本次评价是 {evaluation.get('mode') or '未提供'} 模式，预测跨度为 {horizon} 小时。"
                body = (
                    f"评价对象为 {evaluation.get('target_point_id') or '未提供'}，覆盖 {start} 至 {end}，显示时区为 {evaluation.get('timezone') or '未提供'}。"
                    "这些信息界定了指标的适用范围：它描述的是已公开历史评价窗口，而不是未来时段的保证。"
                    "报告不补写训练配置、未公开切分或无法由 Artifact 证明的样本背景。"
                )
            else:
                takeaway = f"历史测试集 CVRMSE 为 {_format_percent(test.get('cvrmse_percent'))}，需要结合验证集和预测步长理解。"
                body = (
                    f"测试集公开评价覆盖率为 {_format_percent(test.get('evaluation_coverage'), ratio=True)}，验证集 CVRMSE 为 {_format_percent(validation.get('cvrmse_percent'))}。"
                    "测试集与验证集属于不同证据切片，不能简单合并成一个新的总体指标；评价结果也只能说明当前公开回测表现。"
                    "当模型被用于更长预测步长或不同数据质量条件时，应重新检查对应的误差分布和适用边界。"
                )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
            )
        elif section_id == "evaluation-metrics":
            takeaway = f"测试集 CVRMSE 为 {_format_percent(test.get('cvrmse_percent'))}，测试集 R² 为 {_format_number(test.get('r2'))}。"
            body = (
                f"公开指标显示，测试集评价样本数为 {test.get('evaluation_count', '未提供')}，覆盖率为 {_format_percent(test.get('evaluation_coverage'), ratio=True)}；"
                f"验证集 CVRMSE 为 {_format_percent(validation.get('cvrmse_percent'))}。"
                "这组结果应被理解为当前数据切分和目标点位下的历史回测证据，不能直接推导出未来预测的置信度或经济收益。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
            )
        elif section_id == "horizon-errors":
            horizon_rows = metrics.get("test_by_horizon", []) if isinstance(metrics.get("test_by_horizon"), list) else []
            first_horizon = horizon_rows[0] if horizon_rows and isinstance(horizon_rows[0], dict) else {}
            last_horizon = horizon_rows[-1] if horizon_rows and isinstance(horizon_rows[-1], dict) else {}
            takeaway = (
                f"分预测步长结果显示，早期区间 CVRMSE 为 {_format_percent(first_horizon.get('cvrmse_percent'))}，"
                f"末段区间为 {_format_percent(last_horizon.get('cvrmse_percent'))}。"
            )
            body = (
                "按预测步长拆分的误差表用于观察模型表现是否随 horizon 变化。"
                "当前公开结果显示不同步长区间的误差并不相同，因此短期和长时距预测应采用不同的使用预期。"
                "这只是对误差现象的解释，不对误差变化的设备、天气或工况原因作未经证实的因果判断。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action="将长时距预测作为趋势参考使用，并在实际运行中持续回收标签验证误差。",
            )
        elif section_id in {"future-scope", "future-forecast"}:
            start = _format_time(forecast.get("start_at"))
            end = _format_time(forecast.get("end_at"))
            count = prediction_summary.get("prediction_count", "未提供")
            if section_id == "future-scope":
                takeaway = f"未来预测覆盖 {start} 至 {end}，公开预测样本数为 {count}。"
                body = (
                    f"预测对象为 {forecast.get('target_point_id') or '未提供'}，模式为 {forecast.get('mode') or '未提供'}，显示时区为 {forecast.get('timezone') or '未提供'}。"
                    "本节只界定预测的对象、时段和样本范围；由于未来时段尚无历史标签，不能在这里宣称准确率。"
                    "预测输出应与实际运行数据持续对照，并在新的评价 Artifact 形成后再更新判断。"
                )
            else:
                takeaway = f"未来负荷曲线提供了 {count} 个公开预测样本，但不包含历史精度结论。"
                body = (
                    "图表展示 ForecastBundle 已公开的时序输出，适合用于观察预测曲线的时段变化和运行准备。"
                    "曲线本身不能证明峰值一定发生、预测一定准确或某个设备因素造成了变化；这些解释需要额外的标签、阈值或运行证据。"
                    "因此本报告将未来预测和历史评价分开呈现，避免把预测输出误读成模型验证结果。"
                )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
            )
        elif section_id == "future-curve":
            count = prediction_summary.get("prediction_count", "未提供")
            minimum = prediction_summary.get("minimum_raw_prediction")
            takeaway = f"未来预测曲线覆盖 {count} 个样本，当前仅对已公开输出作描述。"
            body = (
                f"公开摘要提供的预测样本数为 {count}，最低原始预测值为 {_format_number(minimum)}。"
                "曲线可用于安排监测和准备，但在没有实际标签、阈值定义或更多运行证据时，不应把视觉上的高低变化解释为确定的设备原因。"
                "后续应将预测值与实际计量数据对齐，形成新的评价证据。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
            )
        elif section_id == "future-range":
            minimum = prediction_summary.get("minimum_raw_prediction")
            takeaway = "当前公开摘要不足以支持独立的峰值或阈值结论。"
            body = (
                f"来源摘要仅提供最低原始预测值 {_format_number(minimum)}，没有公开可验证的峰值、上界或阈值命中结果。"
                "因此本节保留证据缺口，不从图像像素或有限预览样本中估算新的统计量。"
                "待来源补充明确的峰值、范围或阈值 Artifact 后，再将其转化为运行层面的行动建议。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
            )
        elif section_id == "risks-actions":
            risk_text = "；".join(_unique(warnings)[:3]) or "当前来源未产生报告级警告。"
            takeaway = "报告结论应与来源状态、证据链和适用边界一起使用。"
            body = (
                f"当前需要关注的限制包括：{risk_text}。"
                "报告只对已验证公开 Artifact 做整理和解释，没有补算缺失指标，也没有把不同证据层强行合并。"
                "当数据质量、处理链或评价窗口发生变化时，应重新运行上游 Skill 并生成新的报告，而不是沿用旧结论。"
            )
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                takeaway,
                body,
                next_action="按严重性处理来源问题，并在补充证据后复核报告中的限制项。",
            )
        else:
            output[section_id] = _fallback_narrative(
                section_id,
                source_keys,
                sources,
                facts,
                charts,
                "本节结论来自已验证公开摘要。",
                f"本节使用 {labels} 的公开事实进行解释。报告不读取原始数据、不重算上游指标，并保留来源没有提供的证据缺口。",
            )
    return output


def _select_charts(report_type: str, sources: dict[str, SourceArtifact]) -> tuple[list[SourceFile], list[str]]:
    if report_type == "integrated":
        registry = [
            (source_key, chart_id)
            for source_key, chart_ids in (
                ("quality", CHART_SELECTION["quality"][:2]),
                ("processing", CHART_SELECTION["processing"]),
                ("evaluation", CHART_SELECTION["evaluation"]),
                ("forecast", CHART_SELECTION["forecast"]),
            )
            for chart_id in chart_ids
        ]
    elif report_type == "forecast-future":
        registry = [("forecast", chart_id) for chart_id in CHART_SELECTION["forecast"]]
    elif report_type == "forecast-evaluation":
        registry = [("evaluation", chart_id) for chart_id in CHART_SELECTION["evaluation"]]
    else:
        registry = [("quality", chart_id) for chart_id in CHART_SELECTION["quality"]]
    selected: list[SourceFile] = []
    warnings: list[str] = []
    for source_key, chart_id in registry:
        source = sources.get(source_key)
        if source is None:
            continue
        match = next((item for item in source.visualizations if item.chart_id == chart_id), None)
        if match is None:
            continue
        if match not in selected:
            selected.append(match)
        if len(selected) >= MAX_CHARTS:
            break
    for source_key in {key for key, _ in registry}:
        source = sources.get(source_key)
        if source is not None and not any(item for item in selected if item.path.is_relative_to(source.root / "public-artifacts" / source.artifact_id)):
            warnings.append(f"{SOURCE_LABELS[source_key]}来源没有可用于本报告的注册图表。")
    return selected[:MAX_CHARTS], _unique(warnings)


def _evidence_text(source: SourceArtifact) -> str:
    start, end = _time_range(source.summary)
    range_text = "未提供时间范围"
    if start or end:
        range_text = f"{_format_time(start)} 至 {_format_time(end)}"
    target = _target_id(source) or "未提供目标点位"
    return f"{source.artifact_id} · {source.artifact_type} · {source.status} · 时间 {range_text} · 目标 {target}"


def _missing_section(title: str, reason: str) -> dict[str, Any]:
    return {"title": title, "body": [f"当前无法形成本节结论：{reason}"], "source_keys": [], "charts": [], "facts": [], "tables": [], "narrative": None}


def _section(title: str, body: list[str], source_keys: list[str], charts: list[SourceFile], facts: list[tuple[str, str]] | None = None, tables: list[dict[str, Any]] | None = None, narrative: dict[str, Any] | list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"title": title, "body": body, "source_keys": source_keys, "charts": charts, "facts": facts or [], "tables": tables or [], "narrative": narrative}


def build_sections(
    report_type: str,
    sources: dict[str, SourceArtifact],
    facts: dict[str, Any],
    charts: list[SourceFile],
    narratives: dict[str, dict[str, Any]],
    warnings: list[str],
) -> list[dict[str, Any]]:
    by_chart = {item.chart_id: item for item in charts if item.chart_id}
    chart_for = lambda *ids: [by_chart[item] for item in ids if item in by_chart]
    all_keys = list(sources)
    result: list[dict[str, Any]] = []
    quality = facts.get("quality", {})
    evaluation = facts.get("evaluation", {})
    forecast = facts.get("forecast", {})
    processing = facts.get("processing", {})

    takeaways: list[str] = []
    if quality.get("overall_score") is not None:
        takeaways.append(f"数据质量综合评分为 {_format_number(quality.get('overall_score'))} 分，详见六维诊断与问题清单。")
    elif "quality" in sources:
        takeaways.append("质量来源已验证，但公开摘要未提供综合评分。")
    test = evaluation.get("metrics", {}).get("test", {}) if isinstance(evaluation.get("metrics"), dict) else {}
    if isinstance(test, dict) and test.get("cvrmse_percent") is not None:
        takeaways.append(f"历史测试集 CVRMSE 为 {_format_percent(test.get('cvrmse_percent'))}，该数值仅代表已公开的回测评价。")
    if forecast:
        prediction_summary = forecast.get("prediction_summary", {})
        if isinstance(prediction_summary, dict):
            takeaways.append(f"未来预测公开样本数为 {prediction_summary.get('prediction_count', '未提供')}，不代表历史测试精度。")
    if not takeaways:
        takeaways.append("当前来源已通过公开 Artifact 校验，但没有足够的公开摘要形成数值化结论。")
    # Keep the executive summary compact. Each selected image is embedded once
    # in its evidence section so the eight-chart cap counts actual bytes, not
    # repeated placements of the same PNG.
    result.append(_section("", takeaways, all_keys, [], [("报告状态", "见顶部状态带"), ("来源数量", str(len(sources)))], narrative=narratives.get("executive-summary")))

    if report_type in {"integrated", "quality"}:
        rows = []
        for key, source in sources.items():
            start, end = _time_range(source.summary)
            rows.append([SOURCE_LABELS[key], source.artifact_id, source.status, f"{_format_time(start)} 至 {_format_time(end)}", _target_id(source) or "未提供"])
        result.append(_section("", ["报告只使用调用方明确提供并通过完整性校验的公开 Artifact。"], all_keys, [], tables=[{"caption": "来源证据清单", "headers": ["来源", "Artifact ID", "状态", "时间范围", "目标点位"], "rows": rows}], narrative=narratives.get("evidence-chain")))

    if report_type == "quality" or report_type == "integrated":
        if "quality" not in sources:
            result.append(_missing_section("数据质量诊断", "未提供质量 Artifact。"))
        else:
            dimension_rows = [[row["id"], row["name"], str(row.get("status") or "未提供"), _format_number(row.get("score")), str(row.get("summary") or "未提供")] for row in quality.get("dimensions", [])]
            issue_rows = []
            for issue in quality.get("issues", []):
                if not isinstance(issue, dict):
                    continue
                issue_rows.append([str(issue.get("severity") or "未提供"), str(issue.get("dimension") or "未提供"), str(issue.get("summary") or "未提供"), str(issue.get("recommended_action") or "未提供")])
            result.append(_section("", ["质量诊断严格复用 QualityAssessmentBundle 的六维公开摘要；报告不重新计算评分。"], ["quality"], chart_for("quality_score_overview", "quality_overall_score", "issue_severity_counts", "issues_by_dimension"), facts=[("综合评分", _format_number(quality.get("overall_score"))), ("问题数量", str(len(quality.get("issues", []))))], tables=[{"caption": "六维质量结果", "headers": ["维度", "名称", "状态", "评分", "公开摘要"], "rows": dimension_rows}, {"caption": "质量问题与行动建议", "headers": ["严重性", "维度", "问题", "建议"], "rows": issue_rows}], narrative=narratives.get("quality-diagnosis")))
            if report_type == "quality":
                result.append(_section("", ["问题与建议来自质量 Artifact 的公开字段；未将问题升级为新的综合业务评分。"], ["quality"], chart_for("affected_scope_summary"), tables=[{"caption": "重点问题", "headers": ["严重性", "维度", "问题", "建议"], "rows": issue_rows[:20]}], narrative=narratives.get("quality-actions")))
                result.append(_section("", ["以下证据仅用于追溯来源，不代表报告阶段重新抽样或重新计算。"], ["quality"], [], tables=[{"caption": "质量来源元数据", "headers": ["字段", "值"], "rows": [["Artifact ID", sources["quality"].artifact_id], ["源 DatasetBundle", _dataset_id(sources["quality"]) or "未提供"], ["公式版本", str(sources["quality"].native.get("formula_version") or "未提供")], ["时间范围", f"{_format_time(_time_range(sources['quality'].summary)[0])} 至 {_format_time(_time_range(sources['quality'].summary)[1])}"]]}], narrative=narratives.get("evidence-detail")))

    if report_type == "integrated":
        if "processing" not in sources:
            result.append(_missing_section("数据处理与可建模性", "未提供 ProcessingBundle，不能补写处理链事实。"))
        else:
            counts = processing.get("split_sample_counts", {})
            count_rows = [[str(key), str(value)] for key, value in counts.items()] if isinstance(counts, dict) else []
            result.append(_section("", ["处理章节仅展示公开 ProcessingBundle 摘要及泄漏检查元数据。"], ["processing"], chart_for("processed_target_timeline", "gap_and_segment_timeline", "split_timeline"), facts=[("模式", str(processing.get("mode") or "未提供")), ("目标点位", str(processing.get("target_point_id") or "未提供")), ("时间粒度", str(processing.get("data_granularity") or "未提供")), ("泄漏检查", str(processing.get("leakage_check_status") or "未提供"))], tables=[{"caption": "处理上下文", "headers": ["字段", "值"], "rows": [["DatasetBundle", str(processing.get("source_bundle_id") or "未提供")], ["特征规则", str(processing.get("feature_rule_version") or "未提供")], ["泄漏规则", str(processing.get("leakage_check_rule_version") or "未提供")], ["预测范围", f"{_format_time(processing.get('forecast_start'))} 至 {_format_time(processing.get('forecast_end'))}"]]}, {"caption": "分区样本数量", "headers": ["分区", "数量"], "rows": count_rows}], narrative=narratives.get("processing-context")))

    if report_type in {"integrated", "forecast-evaluation"}:
        if "evaluation" not in sources:
            result.append(_missing_section("负荷预测评价" if report_type == "integrated" else "核心指标", "未提供 EvaluationBundle。"))
        else:
            metrics = evaluation.get("metrics", {})
            if report_type == "forecast-evaluation":
                result.append(_section("", ["评价范围取自 EvaluationBundle 的公开摘要，报告不补写未公开的训练配置或数据切分。"], ["evaluation"], [], facts=[("评价时间", f"{_format_time(evaluation.get('start_at'))} 至 {_format_time(evaluation.get('end_at'))}"), ("目标点位", str(evaluation.get("target_point_id") or "未提供")), ("时区", str(evaluation.get("timezone") or "未提供")), ("预测跨度", f"{_format_number(evaluation.get('horizon_hours'))} 小时")], narrative=narratives.get("evaluation-scope")))
            metric_rows = []
            for split in ("test", "validation"):
                row = metrics.get(split) if isinstance(metrics, dict) else None
                if not isinstance(row, dict):
                    continue
                metric_rows.append([split, _format_percent(row.get("cvrmse_percent")), _format_number(row.get("mae")), _format_number(row.get("r2")), _format_percent(row.get("evaluation_coverage"), ratio=True), str(row.get("evaluation_count") or "未提供")])
            evaluation_chart_ids = ["metrics_overview", "actual_vs_prediction", "actual_vs_prediction_scatter"]
            if report_type == "integrated":
                evaluation_chart_ids.append("error_by_horizon")
            metric_narrative_key = "forecast-evaluation" if report_type == "integrated" else "evaluation-metrics"
            result.append(_section("", ["历史评价指标来自 EvaluationBundle 的公开 metrics.json；未来预测章节不会复用这些指标。"], ["evaluation"], chart_for(*evaluation_chart_ids), facts=[("评价模式", str(evaluation.get("mode") or "未提供")), ("目标点位", str(evaluation.get("target_point_id") or "未提供")), ("预测跨度", f"{_format_number(evaluation.get('horizon_hours'))} 小时")], tables=[{"caption": "评价指标", "headers": ["数据分区", "CVRMSE", "MAE", "R²", "评价覆盖率", "评价样本数"], "rows": metric_rows}], narrative=narratives.get(metric_narrative_key)))
            if report_type == "integrated":
                result[-1]["title"] = ""
            horizon_rows = []
            by_horizon = metrics.get("test_by_horizon") if isinstance(metrics, dict) else None
            if isinstance(by_horizon, list):
                for row in by_horizon[:12]:
                    if isinstance(row, dict):
                        horizon_rows.append([f"{row.get('start_minute', '未提供')}–{row.get('end_minute', '未提供')} 分钟", _format_percent(row.get("cvrmse_percent")), _format_number(row.get("mae")), _format_percent(row.get("evaluation_coverage"), ratio=True), str(row.get("evaluation_count") or "未提供")])
            horizon_section = _section("", ["分预测步长误差用于识别误差随 horizon 变化的公开证据，不作因果解释。"], ["evaluation"], [] if report_type == "integrated" else chart_for("error_by_horizon"), tables=[{"caption": "测试集分预测步长指标", "headers": ["预测步长", "CVRMSE", "MAE", "覆盖率", "样本数"], "rows": horizon_rows}], narrative=narratives.get("horizon-errors"))
            if report_type == "integrated":
                result[-1]["body"].extend(horizon_section["body"])
                result[-1]["tables"].extend(horizon_section["tables"])
                existing_narrative = result[-1].get("narrative")
                horizon_narrative = horizon_section.get("narrative")
                if existing_narrative and horizon_narrative:
                    result[-1]["narrative"] = [existing_narrative, horizon_narrative]
                elif horizon_narrative:
                    result[-1]["narrative"] = horizon_narrative
            else:
                result.append(horizon_section)

    if report_type in {"integrated", "forecast-future"}:
        if "forecast" not in sources:
            result.append(_missing_section("未来负荷预测" if report_type == "integrated" else "未来负荷曲线", "未提供 ForecastBundle。"))
        else:
            prediction_summary = forecast.get("prediction_summary", {})
            if report_type == "forecast-future":
                result.append(_section("", ["预测对象、时间范围和显示时区均取自 ForecastBundle 的公开摘要。"], ["forecast"], [], facts=[("目标点位", str(forecast.get("target_point_id") or "未提供")), ("预测模式", str(forecast.get("mode") or "未提供")), ("时间范围", f"{_format_time(forecast.get('start_at'))} 至 {_format_time(forecast.get('end_at'))}"), ("时区", str(forecast.get("timezone") or "未提供"))], narrative=narratives.get("future-scope")))
            future_narrative_key = "future-forecast" if report_type == "integrated" else "future-curve"
            result.append(_section("", ["未来预测仅描述 ForecastBundle 已公开的预测范围和样例；没有历史测试标签时不宣称预测准确率。"], ["forecast"], chart_for("forecast_timeseries", "forecast_summary", "forecast_by_horizon"), facts=[("预测模式", str(forecast.get("mode") or "未提供")), ("预测范围", f"{_format_time(forecast.get('start_at'))} 至 {_format_time(forecast.get('end_at'))}"), ("预测样本数", str(prediction_summary.get("prediction_count") or "未提供")), ("公开跨度", f"{_format_number(forecast.get('horizon_hours'))} 小时")], narrative=narratives.get(future_narrative_key)))
            preview_rows = []
            for row in forecast.get("preview", [])[:12]:
                if isinstance(row, dict):
                    preview_rows.append([_format_time(row.get("timestamp")), _format_number(row.get("prediction")), str(row.get("horizon_step") or "未提供"), str(row.get("unit") or "未提供")])
            preview_section = _section("", ["报告只展示源 Artifact 已公开的预测样例；峰值、范围和阈值结论在来源没有提供时保持未提供。"], ["forecast"], [] if report_type == "integrated" else chart_for("forecast_threshold"), tables=[{"caption": "预测样例（公开预览）", "headers": ["时间", "预测值", "步长", "单位"], "rows": preview_rows}], narrative=narratives.get("future-range"))
            if report_type == "integrated":
                result[-1]["body"].extend(preview_section["body"])
                result[-1]["tables"].extend(preview_section["tables"])
                existing_narrative = result[-1].get("narrative")
                preview_narrative = preview_section.get("narrative")
                if existing_narrative and preview_narrative:
                    result[-1]["narrative"] = [existing_narrative, preview_narrative]
                elif preview_narrative:
                    result[-1]["narrative"] = preview_narrative
            else:
                result.append(preview_section)

    if report_type in {"integrated", "forecast-evaluation", "forecast-future"}:
        limitations = list(warnings)
        limitations.extend(["报告未在生成阶段重算任何上游指标。", "预测评价与未来预测是两个独立证据层，不能相互替代。"])
        result.append(_section("", ["请结合来源状态、证据链和下方限制使用报告。"], all_keys, [], tables=[{"caption": "风险与限制", "headers": ["事项"], "rows": [[item] for item in _unique(limitations)[:30]]}], narrative=narratives.get("risks-actions")))
    for section, (section_id, section_title) in zip(result, SECTION_SKELETONS[report_type]):
        section["section_id"] = section_id
        section["title"] = section_title
    return _attach_visual_notes(result, facts)


def _esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def _narrative_items(value: Any) -> list[dict[str, Any]]:
    raw_items = value if isinstance(value, list) else [value]
    return [item for item in raw_items if isinstance(item, dict)]


def _narrative_paragraphs(value: Any) -> list[str]:
    if not isinstance(value, str):
        return []
    return [item.strip() for item in re.split(r"\n\s*\n|\n", value) if item.strip()]


def _narrative_stats(sections: list[dict[str, Any]]) -> dict[str, Any]:
    eligible = [section for section in sections if section.get("source_keys")]
    covered = [section for section in eligible if _narrative_items(section.get("narrative"))]
    items = [item for section in covered for item in _narrative_items(section.get("narrative"))]
    fallback_sections = [
        str(section.get("section_id"))
        for section in covered
        if any(item.get("origin") == "deterministic-fallback" for item in _narrative_items(section.get("narrative")))
    ]
    codex_count = sum(1 for item in items if item.get("origin") == "codex")
    fallback_count = sum(1 for item in items if item.get("origin") == "deterministic-fallback")
    if codex_count and fallback_count:
        mode = "mixed"
    elif codex_count:
        mode = "codex"
    else:
        mode = "deterministic-fallback"
    visual_notes = [note for section in sections for note in section.get("visual_notes", []) if isinstance(note, dict)]
    character_count = sum(sum(_narrative_char_count(text) for text in _narrative_texts(item)) for item in items)
    character_count += sum(_narrative_char_count(note.get("text")) for note in visual_notes)
    return {
        "policy_version": NARRATIVE_POLICY_VERSION,
        "visual_policy_version": VISUAL_POLICY_VERSION,
        "mode": mode,
        "covered_sections": len(covered),
        "eligible_sections": len(eligible),
        "fallback_sections": fallback_sections,
        "block_count": len(items),
        "visual_note_count": len(visual_notes),
        "character_count": character_count,
    }


def _narrative_mode_label(value: str) -> str:
    return {
        "codex": "Codex 分析",
        "mixed": "Codex 分析 + 兜底",
        "deterministic-fallback": "规则兜底",
    }.get(value, "未提供")


def _visual_note_text(section_id: str, kind: str, ref: str, facts: dict[str, Any]) -> str:
    quality = facts.get("quality", {}) if isinstance(facts.get("quality"), dict) else {}
    evaluation = facts.get("evaluation", {}) if isinstance(facts.get("evaluation"), dict) else {}
    forecast = facts.get("forecast", {}) if isinstance(facts.get("forecast"), dict) else {}
    metrics = evaluation.get("metrics", {}) if isinstance(evaluation.get("metrics"), dict) else {}
    if kind == "chart":
        chart_title = CHART_TITLES.get(ref, ref)
        if ref == "quality_score_overview":
            dimensions = quality.get("dimensions", []) if isinstance(quality.get("dimensions"), list) else []
            scored = [item for item in dimensions if isinstance(item, dict) and isinstance(item.get("score"), (int, float))]
            lowest = min(scored, key=lambda item: float(item["score"])) if scored else None
            lowest_text = f"最低维度为 {lowest.get('name', lowest.get('id'))}（{_format_number(lowest.get('score'))} 分）" if lowest else "最低维度未提供"
            return f"阅读重点：横轴是六个质量维度、纵轴是评分；{lowest_text}，应与下方问题清单交叉核对。该图用于比较维度差异，不单独解释问题原因。"
        if ref == "issue_severity_counts":
            return "阅读重点：颜色区分 info、warning 和 critical，先看问题严重性结构，再回到问题表确认具体维度、证据和建议；图表不替代逐条问题核查。"
        if ref == "issues_by_dimension":
            return "阅读重点：横轴为质量维度，堆叠颜色表示不同严重性；优先关注柱体较高且含高严重性颜色的维度，并以问题表中的原文和行动建议作最终判断。"
        if ref == "processed_target_timeline":
            return "阅读重点：沿时间轴观察处理后目标曲线的连续性和异常段；明显断点或低值段应与缺口、分段和样本排除表一起阅读，不从曲线外观推断设备原因。"
        if ref == "gap_and_segment_timeline":
            return "阅读重点：时间轴展示缺口与持久化标签的覆盖位置；它回答“问题发生在什么时段”，不回答问题为什么发生，原因仍需回到质量和运行证据。"
        if ref == "split_timeline":
            return "阅读重点：比较 train、validation 和 test 在时间轴上的先后与覆盖范围，用于理解评价边界；切分图不能单独证明模型泛化效果。"
        if ref == "metrics_overview":
            return "阅读重点：该图并列展示多种评价指标的相对量级；不同指标量纲和尺度不同，精确数值应以评价表为准，不应按柱高直接比较指标优劣。"
        if ref == "actual_vs_prediction":
            return "阅读重点：沿时间轴对照 actual 与 prediction 的走势和偏离区间；图表用于定位误差出现的时段，整体表现和适用边界仍以 CVRMSE、MAE、R² 及分步长表为准。"
        if ref == "error_by_horizon":
            rows = metrics.get("test_by_horizon", []) if isinstance(metrics.get("test_by_horizon"), list) else []
            first = rows[0] if rows and isinstance(rows[0], dict) else {}
            last = rows[-1] if rows and isinstance(rows[-1], dict) else {}
            return (
                f"阅读重点：横轴为预测步长、纵轴为误差；首段 CVRMSE 为 {_format_percent(first.get('cvrmse_percent'))}，末段为 {_format_percent(last.get('cvrmse_percent'))}。"
                "它用于判断误差是否随步长变化，不对变化原因作未经来源证明的因果解释。"
            )
        if ref == "forecast_timeseries":
            prediction_summary = forecast.get("prediction_summary", {}) if isinstance(forecast.get("prediction_summary"), dict) else {}
            count = prediction_summary.get("prediction_count", "未提供")
            return f"阅读重点：沿时间轴观察未来负荷预测的高低区间和变化节奏；当前公开样本数为 {count}。该图支持运行准备和监测安排，但不代表历史测试精度。"
        return f"阅读重点：图表“{chart_title}”用于呈现来源已公开的视觉证据；请结合章节中的表格、限制说明和证据来源阅读，不把图形外观扩写成未验证结论。"

    table_notes = {
        "来源证据清单": "阅读重点：逐行核对来源 Artifact、状态、时间范围和目标点位；只有公开链路一致时才适合形成跨来源结论。",
        "六维质量结果": "阅读重点：按维度对照状态、评分和公开摘要；评分用于定位治理优先级，具体原因和行动以问题清单为准。",
        "质量问题与行动建议": "阅读重点：先按严重性和维度筛选，再核对原始问题与来源建议；表格中的建议不是报告阶段新增的设备诊断。",
        "重点问题": "阅读重点：这是质量问题的聚焦清单，适合确定先处理什么；完成治理后应保留原始值和标记，并用新的质量 Artifact 复核。",
        "质量来源元数据": "阅读重点：用于审计 Artifact 身份、数据范围和公式版本；元数据证明可追溯性，不等于报告重新验证了底层记录。",
        "处理上下文": "阅读重点：核对 DatasetBundle、特征规则、泄漏规则和预测范围，先确认建模上下文一致，再解读预测结果。",
        "分区样本数量": "阅读重点：比较 train、validation、test 的样本规模，理解评价证据来自哪个分区；不据此推导模型准确率。",
        "评价指标": "阅读重点：分别查看 test 与 validation 的 CVRMSE、MAE、R²、覆盖率和样本数；不要把不同分区拼成新的总体指标。",
        "测试集分预测步长指标": "阅读重点：逐行比较不同预测步长的误差和覆盖率；表格给出精确值，适合与误差曲线交叉阅读。",
        "预测样例（公开预览）": "阅读重点：这是来源公开预览的样例核对表，可查看时间、预测值、步长和单位；它不支持单独的准确率或峰值结论。",
        "风险与限制": "阅读重点：把每一项限制与对应章节结论一起阅读；如果来源、质量或处理链发生变化，应重新运行上游 Skill 和报告。",
        "关键事实": "阅读重点：这是本节最小事实集，先确认字段含义、单位和范围，再理解图表与叙事解释。",
    }
    return table_notes.get(ref, f"阅读重点：表格“{ref}”用于核对公开事实和适用边界；精确值以表格为准，不从缺失字段推导新结论。")


def _attach_visual_notes(sections: list[dict[str, Any]], facts: dict[str, Any]) -> list[dict[str, Any]]:
    for section in sections:
        provided: dict[tuple[str, str], str] = {}
        for item in _narrative_items(section.get("narrative")):
            raw_notes = item.get("visual_notes", [])
            if not isinstance(raw_notes, list):
                continue
            for note in raw_notes:
                if not isinstance(note, dict):
                    continue
                kind = note.get("kind")
                ref = note.get("ref")
                text = note.get("text")
                if kind in {"chart", "table"} and isinstance(ref, str) and isinstance(text, str):
                    provided[(kind, ref)] = text
        notes: list[dict[str, str]] = []
        for chart in section.get("charts", []):
            ref = chart.chart_id or ""
            notes.append({"kind": "chart", "ref": ref, "text": provided.get(("chart", ref)) or _visual_note_text(section.get("section_id", ""), "chart", ref, facts)})
        for table in section.get("tables", []):
            ref = str(table.get("caption") or "证据表") if isinstance(table, dict) else "证据表"
            notes.append({"kind": "table", "ref": ref, "text": provided.get(("table", ref)) or _visual_note_text(section.get("section_id", ""), "table", ref, facts)})
        section["visual_notes"] = notes
    return sections


def _visual_note_for(section: dict[str, Any], kind: str, ref: str) -> str:
    for note in section.get("visual_notes", []):
        if isinstance(note, dict) and note.get("kind") == kind and note.get("ref") == ref:
            return str(note.get("text") or "")
    return ""


def _chart_html(chart: SourceFile, visual_note: str = "") -> str:
    encoded = base64.b64encode(chart.path.read_bytes()).decode("ascii")
    title = chart.chart_title or CHART_TITLES.get(chart.chart_id or "", chart.chart_id or "图表")
    return "".join(
        [
            f'<div class="visual-analysis"><div class="visual-label">图表解读</div><p>{_esc(visual_note)}</p></div>' if visual_note else "",
            '<figure class="chart">',
            f'<img src="data:image/png;base64,{encoded}" alt="{_esc(title)}">',
            f'<figcaption><strong>{_esc(title)}</strong><span>来源图表 · 已通过完整性校验</span></figcaption>',
            "</figure>",
        ]
    )


def _table_html(table: dict[str, Any], visual_note: str = "") -> str:
    headers = table.get("headers", [])
    rows = table.get("rows", [])
    output = [
        f'<div class="visual-analysis"><div class="visual-label">表格解读</div><p>{_esc(visual_note)}</p></div>' if visual_note else "",
        f'<div class="table-wrap"><h4>{_esc(table.get("caption", "证据表"))}</h4><table><thead><tr>',
    ]
    output.extend(f"<th>{_esc(header)}</th>" for header in headers)
    output.append("</tr></thead><tbody>")
    if rows:
        for row in rows:
            output.append("<tr>")
            output.extend(f"<td>{_esc(value)}</td>" for value in row)
            output.append("</tr>")
    else:
        output.append(f'<tr><td class="empty" colspan="{max(1, len(headers))}">未提供</td></tr>')
    output.append("</tbody></table></div>")
    return "".join(output)


def render_html(
    title: str,
    report_type: str,
    status: str,
    sources: dict[str, SourceArtifact],
    sections: list[dict[str, Any]],
    warnings: list[str],
) -> bytes:
    status_label = "已完成" if status == "succeeded" else "部分完成"
    status_class = "complete" if status == "succeeded" else "partial"
    narrative_stats = _narrative_stats(sections)
    source_cards = "".join(f'<span class="source-chip">{_esc(SOURCE_LABELS[key])} · {_esc(source.artifact_id)} · {_esc(source.status)}</span>' for key, source in sources.items())
    section_html: list[str] = []
    for index, section in enumerate(sections, 1):
        body = "".join(f"<p>{_esc(item)}</p>" for item in section.get("body", []))
        fact_html = ""
        facts = section.get("facts", [])
        if facts:
            fact_html = '<div class="fact-grid">' + "".join(f'<div class="fact"><span>{_esc(label)}</span><strong>{_esc(value)}</strong></div>' for label, value in facts) + "</div>"
        charts = "".join(_chart_html(chart, _visual_note_for(section, "chart", chart.chart_id or "")) for chart in section.get("charts", []))
        tables = "".join(_table_html(table, _visual_note_for(section, "table", str(table.get("caption") or "证据表"))) for table in section.get("tables", []) if isinstance(table, dict))
        evidence = "".join(f'<li>{_esc(_evidence_text(sources[key]))}</li>' for key in section.get("source_keys", []) if key in sources)
        evidence_html = f'<div class="evidence"><span>证据来源</span><ul>{evidence or "<li>未提供可验证来源</li>"}</ul></div>'
        narrative = section.get("narrative")
        narrative_html = ""
        for narrative_item in _narrative_items(narrative):
            paragraphs = "".join(f'<p>{_esc(paragraph)}</p>' for paragraph in _narrative_paragraphs(narrative_item.get("body", "")))
            narrative_html += f'<aside class="narrative"><div class="narrative-label">分析解读</div><strong>{_esc(narrative_item.get("takeaway", ""))}</strong>{paragraphs}'
            chart_refs = [CHART_TITLES.get(str(item), str(item)) for item in narrative_item.get("chart_refs", []) if item]
            if chart_refs:
                narrative_html += f'<p class="narrative-meta"><b>关联图表：</b>{_esc("、".join(chart_refs))}</p>'
            caveats = narrative_item.get("caveats", [])
            if isinstance(caveats, list) and caveats:
                narrative_html += f'<p class="narrative-meta"><b>解读边界：</b>{_esc("；".join(str(item) for item in caveats))}</p>'
            if narrative_item.get("next_action"):
                narrative_html += f'<p class="narrative-action"><b>行动建议：</b>{_esc(narrative_item["next_action"])}</p>'
            narrative_html += "</aside>"
        section_html.append(f'<section class="report-section"><div class="section-kicker">0{index}</div><h2>{_esc(section.get("title") or "报告章节")}</h2>{narrative_html}{body}{fact_html}{charts}{tables}{evidence_html}</section>')
    warning_html = "".join(f"<li>{_esc(item)}</li>" for item in warnings[:30])
    html_text = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(title)}</title>
<style>
:root {{ color-scheme: light; --navy:#123149; --graphite:#33424d; --muted:#687985; --line:#dce5e8; --surface:#f5f8f8; --teal:#087f79; --orange:#c56d25; --red:#b54443; }}
* {{ box-sizing:border-box; }}
html {{ background:#eef2f2; }}
body {{ margin:0; color:var(--graphite); background:#fff; font-family:"Times New Roman","Noto Serif CJK SC","STSong","SimSun",serif; font-size:16px; line-height:1.85; }}
.report {{ max-width:1120px; margin:0 auto; padding:52px 64px 80px; background:#fff; }}
.cover {{ border-top:7px solid var(--navy); padding:26px 0 30px; border-bottom:1px solid var(--line); }}
.eyebrow,.section-kicker {{ color:var(--teal); font-size:12px; letter-spacing:.16em; font-weight:700; text-transform:uppercase; }}
h1 {{ margin:10px 0 12px; color:var(--navy); font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif; font-size:38px; line-height:1.25; letter-spacing:-.02em; }}
h2 {{ margin:0 0 16px; color:var(--navy); font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif; font-size:25px; line-height:1.35; }}
h3,h4 {{ color:var(--navy); }}
.subtitle {{ color:var(--muted); font-size:14px; }}
.status {{ display:inline-flex; align-items:center; gap:8px; margin:22px 0 18px; padding:7px 12px; border-radius:999px; font-weight:700; font-size:13px; }}
.status.complete {{ color:#075e5a; background:#e1f2ef; }} .status.partial {{ color:#8a4c12; background:#fff0df; }}
.status-dot {{ width:8px; height:8px; border-radius:50%; background:currentColor; }}
.meta-grid,.fact-grid {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }}
.meta,.fact {{ padding:13px 15px; border:1px solid var(--line); background:var(--surface); border-radius:8px; }}
.meta span,.fact span {{ display:block; color:var(--muted); font-size:13px; margin-bottom:3px; }}
.meta strong,.fact strong {{ display:block; color:var(--navy); font-size:16px; overflow-wrap:anywhere; }}
.source-strip {{ display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }}
.source-chip {{ padding:5px 9px; color:var(--navy); background:#eef4f4; border:1px solid #d8e7e5; border-radius:5px; font-size:12px; }}
.warning-banner {{ margin:24px 0 36px; padding:16px 18px; border-left:4px solid var(--orange); background:#fff8ee; }}
.warning-banner strong {{ color:#8a4c12; }}
.warning-banner ul {{ margin:7px 0 0 18px; padding:0; }}
.report-section {{ padding:34px 0 40px; border-bottom:1px solid var(--line); break-inside:avoid; }}
.report-section p {{ margin:0 0 10px; }}
.section-kicker {{ margin-bottom:7px; color:var(--muted); }}
.fact-grid {{ margin:20px 0; grid-template-columns:repeat(4,minmax(0,1fr)); }}
.chart {{ margin:24px 0 28px; padding:0; }}
.chart img {{ display:block; width:100%; max-height:540px; object-fit:contain; border:1px solid var(--line); background:#fff; }}
.chart figcaption {{ display:flex; justify-content:space-between; gap:14px; padding:9px 2px 0; color:var(--muted); font-size:13px; }}
.chart figcaption strong {{ color:var(--navy); font-size:15px; }}
.table-wrap {{ margin:22px 0; overflow-x:auto; }}
.table-wrap h4 {{ margin:0 0 9px; color:var(--navy); font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif; font-size:16px; }}
table {{ width:100%; border-collapse:collapse; font-size:14px; line-height:1.65; }}
th,td {{ padding:9px 10px; border:1px solid var(--line); text-align:left; vertical-align:top; }}
th {{ color:var(--navy); background:#eef4f4; font-weight:700; }}
td.empty {{ color:var(--muted); text-align:center; }}
.evidence {{ margin-top:24px; padding:13px 15px; color:var(--muted); background:#fafcfc; border:1px solid var(--line); font-size:12px; }}
.evidence span {{ color:var(--navy); font-weight:700; }} .evidence ul {{ margin:5px 0 0 18px; padding:0; }}
.narrative {{ margin:20px 0 28px; padding:19px 21px; border-left:4px solid var(--teal); background:#f0f8f7; }}
.narrative-label {{ margin-bottom:6px; color:var(--teal); font-size:12px; font-weight:700; letter-spacing:.08em; }}
.narrative strong {{ display:block; margin-bottom:9px; color:var(--navy); font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif; font-size:18px; line-height:1.55; }}
.narrative p {{ margin:0 0 9px; }}
.narrative p:last-child {{ margin-bottom:0; }}
.narrative-meta {{ color:var(--muted); font-size:13px; }}
.narrative-action {{ color:#315e5b; }}
.visual-analysis {{ margin:20px 0 10px; padding:11px 14px; border-left:3px solid #8dbbb7; background:#f7fbfa; color:#46605f; }}
.visual-analysis .visual-label {{ margin-bottom:3px; color:var(--teal); font-family:"Noto Sans CJK SC","Microsoft YaHei","Arial",sans-serif; font-size:13px; font-weight:700; }}
.visual-analysis p {{ margin:0; font-size:15px; line-height:1.7; }}
.footer {{ padding-top:28px; color:var(--muted); font-size:12px; }}
@media (max-width:760px) {{ .report {{ padding:30px 22px 52px; }} h1 {{ font-size:30px; }} .meta-grid,.fact-grid {{ grid-template-columns:1fr 1fr; }} .chart figcaption {{ display:block; }} }}
@media print {{ html,body {{ background:#fff; }} .report {{ max-width:none; padding:18mm 14mm; }} .warning-banner {{ break-inside:avoid; }} .chart img {{ max-height:220mm; }} }}
</style>
</head>
<body>
<main class="report">
<header class="cover">
<div class="eyebrow">建筑能源证据分析报告</div>
<h1>{_esc(title)}</h1>
<div class="subtitle">{_esc(REPORT_TYPES[report_type])} · 证据优先 · 离线自包含 HTML</div>
<div class="status {status_class}"><span class="status-dot"></span>{_esc(status_label)}</div>
<div class="meta-grid">
<div class="meta"><span>报告类型</span><strong>{_esc(report_type)}</strong></div>
<div class="meta"><span>显示时区</span><strong>Asia/Shanghai</strong></div>
<div class="meta"><span>图表数量</span><strong>{sum(len(section.get("charts", [])) for section in sections)}</strong></div>
<div class="meta"><span>文字解读</span><strong>{_esc(_narrative_mode_label(narrative_stats["mode"]))} · {_esc(narrative_stats["covered_sections"])} / {_esc(narrative_stats["eligible_sections"])}</strong></div>
</div>
<div class="source-strip">{source_cards or '<span class="source-chip">未提供来源</span>'}</div>
</header>
{f'<div class="warning-banner"><strong>报告存在限制或来源警告</strong><ul>{warning_html}</ul></div>' if warnings else ''}
{''.join(section_html)}
<footer class="footer">本报告由已验证的建筑能源 Artifact 生成。报告阶段不重算指标、不读取原始数据，不将未来预测解释为历史测试精度。</footer>
</main>
</body>
</html>
'''
    return html_text.encode("utf-8")


def _qa_html(value: bytes, chart_count: int, narrative_count: int, visual_count: int) -> dict[str, Any]:
    text = value.decode("utf-8")
    forbidden = ["<script", "<iframe", "<form", "@import", "src=\"http", "href=\"http", "url("]
    found = [marker for marker in forbidden if marker in text.lower()]
    if found:
        raise ReportFailure("REPORT_QA_FAILED", f"报告包含不允许的活动内容：{', '.join(found)}。")
    if chart_count > MAX_CHARTS:
        raise ReportFailure("REPORT_QA_FAILED", "报告图表数量超过固定上限。")
    if text.count("data:image/png;base64,") != chart_count:
        raise ReportFailure("REPORT_QA_FAILED", "报告中的嵌入图表数量与注册表不一致。")
    if text.count('class="narrative"') != narrative_count:
        raise ReportFailure("REPORT_QA_FAILED", "报告中的分析解读数量与章节数据不一致。")
    if text.count('class="visual-analysis"') != visual_count:
        raise ReportFailure("REPORT_QA_FAILED", "报告中的图表/表格解读数量与视觉元素不一致。")
    return {
        "self_contained": True,
        "external_resources": False,
        "active_content": False,
        "chart_count": chart_count,
        "narrative_count": narrative_count,
        "visual_note_count": visual_count,
        "size_bytes": len(value),
    }


PDF_LATIN_TOKEN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9.,:%_+\-/=#]*[A-Za-z0-9%])?")


def _register_pdf_fonts(pdfmetrics: Any) -> None:
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFont

    if PDF_CJK_FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(UnicodeCIDFont(PDF_CJK_FONT_NAME))
    font_paths = {
        PDF_LATIN_FONT_NAME: (
            "/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/times.ttf",
        ),
        PDF_LATIN_BOLD_FONT_NAME: (
            "/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold.ttf",
            "/usr/share/fonts/truetype/msttcorefonts/timesbd.ttf",
        ),
    }
    for font_name, candidates in font_paths.items():
        if font_name in pdfmetrics.getRegisteredFontNames():
            continue
        path = next((Path(candidate) for candidate in candidates if Path(candidate).is_file()), None)
        if path is None:
            raise ReportFailure("DEPENDENCY_MISSING", f"PDF 所需字体不可用：{font_name}（需要 Times New Roman 字体文件）。")
        pdfmetrics.registerFont(TTFont(font_name, str(path)))


def _pdf_markup(value: Any, latin_font: str = PDF_LATIN_FONT_NAME) -> str:
    raw = str(value).replace("·", "｜")
    output: list[str] = []
    cursor = 0
    for match in PDF_LATIN_TOKEN.finditer(raw):
        prefix = raw[cursor : match.start()]
        if prefix:
            output.append(html.escape(prefix, quote=False).replace("\n", "<br/>"))
        token = html.escape(match.group(0), quote=False).replace("\n", "<br/>")
        output.append(f'<font name="{latin_font}">{token}</font>')
        cursor = match.end()
    suffix = raw[cursor:]
    if suffix:
        output.append(html.escape(suffix, quote=False).replace("\n", "<br/>"))
    return "".join(output)


def render_pdf(
    title: str,
    report_type: str,
    status: str,
    sources: dict[str, SourceArtifact],
    sections: list[dict[str, Any]],
    warnings: list[str],
) -> bytes:
    """Render the same deterministic sections and verified PNGs as a PDF."""

    try:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.lib.utils import ImageReader
        from reportlab.platypus import Image as PdfImage
        from reportlab.platypus import KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    except ImportError as exc:
        raise ReportFailure(
            "DEPENDENCY_MISSING",
            "PDF 生成依赖 reportlab 不可用，请运行 scripts/install-skills building-energy-report-generation。",
        ) from exc

    _register_pdf_fonts(pdfmetrics)
    font_name = PDF_CJK_FONT_NAME
    navy = colors.HexColor("#123149")
    graphite = colors.HexColor("#33424D")
    muted = colors.HexColor("#687985")
    line = colors.HexColor("#DCE5E8")
    surface = colors.HexColor("#F5F8F8")
    teal = colors.HexColor("#087F79")
    orange = colors.HexColor("#C56D25")
    page_width, page_height = A4
    margin = 18 * mm

    cover_kicker = ParagraphStyle(
        "ReportCoverKicker",
        fontName=font_name,
        fontSize=10,
        leading=14,
        textColor=teal,
        alignment=TA_CENTER,
        spaceAfter=12,
    )
    cover_title = ParagraphStyle(
        "ReportCoverTitle",
        fontName=font_name,
        fontSize=26,
        leading=35,
        textColor=navy,
        alignment=TA_CENTER,
        spaceAfter=9,
    )
    cover_subtitle = ParagraphStyle(
        "ReportCoverSubtitle",
        fontName=font_name,
        fontSize=11,
        leading=17,
        textColor=muted,
        alignment=TA_CENTER,
        spaceAfter=12,
    )
    section_kicker = ParagraphStyle(
        "ReportSectionKicker",
        fontName=font_name,
        fontSize=10,
        leading=14,
        textColor=teal,
        spaceBefore=5,
        spaceAfter=3,
    )
    heading = ParagraphStyle(
        "ReportHeading",
        fontName=font_name,
        fontSize=18,
        leading=26,
        textColor=navy,
        spaceBefore=3,
        spaceAfter=9,
    )
    body = ParagraphStyle(
        "ReportBody",
        fontName=font_name,
        fontSize=PDF_BODY_FONT_SIZE,
        leading=20,
        textColor=graphite,
        spaceAfter=6,
    )
    small = ParagraphStyle(
        "ReportSmall",
        fontName=font_name,
        fontSize=9.5,
        leading=13,
        textColor=muted,
        spaceAfter=3,
    )
    table_text = ParagraphStyle(
        "ReportTableText",
        parent=body,
        fontSize=9.5,
        leading=14,
        spaceAfter=0,
    )
    table_header = ParagraphStyle(
        "ReportTableHeader",
        parent=table_text,
        textColor=colors.white,
    )
    narrative_title = ParagraphStyle(
        "ReportNarrativeTitle",
        parent=body,
        fontSize=13,
        leading=20,
        textColor=navy,
        spaceAfter=4,
    )
    narrative_body = ParagraphStyle(
        "ReportNarrativeBody",
        parent=body,
        fontSize=PDF_BODY_FONT_SIZE,
        leading=19,
        spaceAfter=0,
    )
    narrative_label = ParagraphStyle(
        "ReportNarrativeLabel",
        parent=body,
        fontSize=10,
        leading=14,
        textColor=teal,
        spaceAfter=3,
    )
    narrative_meta = ParagraphStyle(
        "ReportNarrativeMeta",
        parent=small,
        fontSize=9.5,
        leading=13,
        spaceAfter=2,
    )

    def paragraph(value: Any, style: ParagraphStyle = body, *, latin_font: str = PDF_LATIN_FONT_NAME) -> Paragraph:
        return Paragraph(_pdf_markup(value, latin_font), style)

    def table_flowable(table: dict[str, Any]) -> Table:
        raw_headers = table.get("headers", [])
        headers = [str(value) for value in raw_headers] if isinstance(raw_headers, list) else []
        raw_rows = table.get("rows", [])
        rows = raw_rows if isinstance(raw_rows, list) else []
        column_count = max(1, len(headers), *(len(row) for row in rows if isinstance(row, list)))
        if not headers:
            headers = ["字段"]
        headers = headers[:column_count] + ["未提供"] * max(0, column_count - len(headers))
        data = [[paragraph(value, table_header, latin_font=PDF_LATIN_BOLD_FONT_NAME) for value in headers]]
        for row in rows:
            values = row if isinstance(row, list) else [row]
            values = values[:column_count] + ["未提供"] * max(0, column_count - len(values))
            data.append([paragraph(value, table_text) for value in values])
        if len(data) == 1:
            data.append([paragraph("未提供", table_text)] + [paragraph("", table_text)] * (column_count - 1))
        weights = []
        for header in headers:
            label = str(header)
            if label in {"问题", "建议", "公开摘要", "事项"}:
                weights.append(2.5)
            elif label in {"Artifact ID", "时间范围", "目标点位", "预测范围"}:
                weights.append(1.7)
            elif label in {"值", "状态", "评分", "严重性", "覆盖率", "样本数"}:
                weights.append(1.1)
            else:
                weights.append(1.35)
        total_weight = sum(weights) or float(column_count)
        table = Table(data, colWidths=[doc.width * weight / total_weight for weight in weights], repeatRows=1, hAlign="LEFT")
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), navy),
                    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                    ("GRID", (0, 0), (-1, -1), 0.35, line),
                    ("BACKGROUND", (0, 1), (-1, -1), surface),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]
            )
        )
        return table

    def narrative_flowables(value: Any) -> list[Table]:
        output: list[Table] = []
        for item in _narrative_items(value):
            content: list[list[Any]] = [[paragraph("分析解读", narrative_label, latin_font=PDF_LATIN_BOLD_FONT_NAME)]]
            content.append([paragraph(item.get("takeaway", ""), narrative_title, latin_font=PDF_LATIN_BOLD_FONT_NAME)])
            content.extend([[paragraph(text, narrative_body)] for text in _narrative_paragraphs(item.get("body", ""))])
            chart_refs = [CHART_TITLES.get(str(chart_id), str(chart_id)) for chart_id in item.get("chart_refs", []) if chart_id]
            if chart_refs:
                content.append([paragraph(f"关联图表：{'、'.join(chart_refs)}", narrative_meta)])
            caveats = item.get("caveats", [])
            if isinstance(caveats, list) and caveats:
                content.append([paragraph(f"解读边界：{'；'.join(str(caveat) for caveat in caveats)}", narrative_meta)])
            if item.get("next_action"):
                content.append([paragraph(f"行动建议：{item['next_action']}", narrative_body)])
            narrative = Table(content, colWidths=[doc.width], hAlign="LEFT")
            narrative.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F0F8F7")),
                        ("LINEBEFORE", (0, 0), (0, -1), 2.5, teal),
                        ("BOX", (0, 0), (-1, -1), 0.35, line),
                        ("LEFTPADDING", (0, 0), (-1, -1), 10),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                        ("TOPPADDING", (0, 0), (-1, -1), 8),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                    ]
                )
            )
            output.append(KeepTogether([narrative, Spacer(1, 7)]))
        return output

    def footer(canvas: Any, document: Any) -> None:
        canvas.saveState()
        canvas.setStrokeColor(line)
        canvas.setLineWidth(0.45)
        canvas.line(margin, 13 * mm, page_width - margin, 13 * mm)
        canvas.setFont(font_name, 8.5)
        canvas.setFillColor(muted)
        canvas.drawString(margin, 8 * mm, "建筑能源证据分析报告 · 离线 PDF")
        canvas.drawRightString(page_width - margin, 8 * mm, f"第 {document.page} 页")
        canvas.restoreState()

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=17 * mm,
        bottomMargin=20 * mm,
        title=title,
        author="Building Energy Codex",
        subject=REPORT_TYPES[report_type],
        allowSplitting=1,
    )
    story: list[Any] = [
        Spacer(1, 28 * mm),
        paragraph("建筑能源证据分析报告", cover_kicker, latin_font=PDF_LATIN_BOLD_FONT_NAME),
        paragraph(title, cover_title, latin_font=PDF_LATIN_BOLD_FONT_NAME),
        paragraph(f"{REPORT_TYPES[report_type]} · 证据优先 · 离线自包含 PDF", cover_subtitle),
    ]
    status_label = "已完成" if status == "succeeded" else "部分完成"
    status_color = teal if status == "succeeded" else orange
    status_table = Table([[paragraph(f"报告状态：{status_label}", cover_subtitle, latin_font=PDF_LATIN_BOLD_FONT_NAME)]], colWidths=[doc.width], hAlign="LEFT")
    status_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F5F8F8")),
                ("BOX", (0, 0), (-1, -1), 0.6, status_color),
                ("TEXTCOLOR", (0, 0), (-1, -1), status_color),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
            ]
        )
    )
    story.extend([status_table, Spacer(1, 10 * mm)])
    narrative_stats = _narrative_stats(sections)
    meta = [
        [paragraph("报告类型", table_header, latin_font=PDF_LATIN_BOLD_FONT_NAME), paragraph("显示时区", table_header, latin_font=PDF_LATIN_BOLD_FONT_NAME), paragraph("图表数量", table_header, latin_font=PDF_LATIN_BOLD_FONT_NAME), paragraph("文字解读", table_header, latin_font=PDF_LATIN_BOLD_FONT_NAME)],
        [paragraph(REPORT_TYPES[report_type], table_text), paragraph("Asia/Shanghai", table_text), paragraph(sum(len(section.get("charts", [])) for section in sections), table_text), paragraph(f"{_narrative_mode_label(narrative_stats['mode'])} · {narrative_stats['covered_sections']} / {narrative_stats['eligible_sections']}", table_text)],
    ]
    meta_table = Table(meta, colWidths=[doc.width / 4] * 4, hAlign="LEFT")
    meta_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), navy),
                ("BACKGROUND", (0, 1), (-1, 1), surface),
                ("GRID", (0, 0), (-1, -1), 0.35, line),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(meta_table)
    source_text = "\n".join(f"{SOURCE_LABELS[key]} · {_evidence_text(source)}" for key, source in sources.items())
    story.extend([Spacer(1, 8 * mm), paragraph(source_text or "未提供来源", small)])
    if warnings:
        warning_text = "\n".join(warnings[:30])
        warning_table = Table([[paragraph(f"报告限制与来源警告\n{warning_text}", body)]], colWidths=[doc.width], hAlign="LEFT")
        warning_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF7ED")),
                    ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#E8B77A")),
                    ("LINEBEFORE", (0, 0), (0, -1), 2.5, orange),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.extend([Spacer(1, 8 * mm), warning_table])
    story.append(PageBreak())

    for index, section in enumerate(sections, 1):
        section_header = [
            paragraph(f"0{index}", section_kicker, latin_font=PDF_LATIN_BOLD_FONT_NAME),
            paragraph(section.get("title") or "报告章节", heading, latin_font=PDF_LATIN_BOLD_FONT_NAME),
        ]
        section_narratives = narrative_flowables(section.get("narrative"))
        if section_narratives:
            story.append(KeepTogether([*section_header, section_narratives[0]]))
            story.extend(section_narratives[1:])
        else:
            story.extend(section_header)
        story.extend(paragraph(item) for item in section.get("body", []))
        facts = section.get("facts", [])
        if facts:
            fact_table = {"caption": "关键事实", "headers": ["字段", "值"], "rows": [[label, value] for label, value in facts]}
            story.append(paragraph(fact_table["caption"], section_kicker, latin_font=PDF_LATIN_BOLD_FONT_NAME))
            story.append(table_flowable(fact_table))
            story.append(Spacer(1, 7))
        for chart in section.get("charts", []):
            try:
                width, height = ImageReader(str(chart.path)).getSize()
            except Exception as exc:
                raise ReportFailure("REPORT_QA_FAILED", f"PDF 无法读取图表：{chart.relative_path}。") from exc
            scale = min(doc.width / max(width, 1), (PDF_VISUAL_MAX_HEIGHT_MM * mm) / max(height, 1), 1.0)
            image = PdfImage(str(chart.path), width=width * scale, height=height * scale)
            image.hAlign = "LEFT"
            visual_note = _visual_note_for(section, "chart", chart.chart_id or "")
            visual_story = [paragraph("图表解读", narrative_label, latin_font=PDF_LATIN_BOLD_FONT_NAME), paragraph(visual_note, narrative_body)] if visual_note else []
            chart_caption = paragraph(f"图表：{chart.chart_title or chart.chart_id or '未提供'} · 来源图表已通过完整性校验", small)
            story.append(KeepTogether([*visual_story, image, chart_caption, Spacer(1, 5)]))
        for table in section.get("tables", []):
            caption = table.get("caption") if isinstance(table, dict) else "证据表"
            visual_note = _visual_note_for(section, "table", str(caption or "证据表"))
            if visual_note:
                story.append(paragraph("表格解读", narrative_label, latin_font=PDF_LATIN_BOLD_FONT_NAME))
                story.append(paragraph(visual_note, narrative_body))
            story.append(paragraph(caption or "证据表", section_kicker, latin_font=PDF_LATIN_BOLD_FONT_NAME))
            story.append(table_flowable(table if isinstance(table, dict) else {}))
            story.append(Spacer(1, 7))
        story.append(paragraph("证据来源", section_kicker, latin_font=PDF_LATIN_BOLD_FONT_NAME))
        evidence = [sources[key] for key in section.get("source_keys", []) if key in sources]
        if evidence:
            story.extend(paragraph(_evidence_text(source), small) for source in evidence)
        else:
            story.append(paragraph("未提供可验证来源", small))
        if index < len(sections):
            story.append(Spacer(1, 10 * mm))

    try:
        doc.build(story, onFirstPage=footer, onLaterPages=footer)
    except ReportFailure:
        raise
    except Exception as exc:
        raise ReportFailure("REPORT_QA_FAILED", f"PDF 报告渲染失败：{type(exc).__name__}。") from exc
    pdf_value = buffer.getvalue()
    # ReportLab writes a vendor URL in producer comments. Replace it with an
    # equal-length local marker so PDF cross-reference offsets stay valid while
    # the deliverable remains free of external references.
    pdf_value = pdf_value.replace(b"http://www.reportlab.com", b"building-energy-renderer")
    pdf_value = pdf_value.replace(b"www.reportlab.com", b"energy-pdf-engine")
    return pdf_value


def _qa_pdf(value: bytes, chart_count: int, narrative_count: int, visual_count: int) -> dict[str, Any]:
    if not value.startswith(b"%PDF-") or not value.rstrip().endswith(b"%%EOF"):
        raise ReportFailure("REPORT_QA_FAILED", "PDF 文件头或结束标记无效。")
    structure_parts: list[bytes] = []
    cursor = 0
    stream_header = re.compile(rb"/Length\s+(\d+)(?:(?!>>).)*>>\s*stream\r?\n", re.DOTALL)
    for match in stream_header.finditer(value):
        if match.start() < cursor:
            continue
        payload_start = match.end()
        payload_end = payload_start + int(match.group(1))
        if payload_end > len(value):
            raise ReportFailure("REPORT_QA_FAILED", "PDF 图表数据流长度无效。")
        structure_parts.append(value[cursor:payload_start])
        cursor = payload_end
    structure_parts.append(value[cursor:])
    structure = b"".join(structure_parts)
    forbidden = [b"/JavaScript", b"/JS", b"/Launch", b"/URI", b"http://", b"https://", b"www."]
    found = [marker.decode("ascii") for marker in forbidden if marker in structure]
    if found:
        raise ReportFailure("REPORT_QA_FAILED", f"PDF 包含不允许的活动内容：{', '.join(found)}。")
    image_count = value.count(b"/Subtype /Image")
    if image_count < chart_count:
        raise ReportFailure("REPORT_QA_FAILED", "PDF 中的嵌入图表数量少于注册表。")
    if b"TimesNewRoman" not in value or b"STSong-Light" not in value:
        raise ReportFailure("REPORT_QA_FAILED", "PDF 未包含规定的 Times New Roman 与宋体字体资源。")
    return {
        "self_contained": True,
        "external_resources": False,
        "active_content": False,
        "chart_count": chart_count,
        "narrative_count": narrative_count,
        "visual_note_count": visual_count,
        "embedded_image_count": image_count,
        "body_font": f"{PDF_CJK_FONT_NAME} {PDF_BODY_FONT_SIZE}pt",
        "latin_font": "Times New Roman",
        "size_bytes": len(value),
    }


def _default_title(report_type: str, sources: dict[str, SourceArtifact]) -> str:
    target = next((_target_id(source) for source in sources.values() if _target_id(source)), None)
    suffix = f"（{target}）" if target else ""
    return f"{REPORT_TYPES[report_type]}{suffix}"


def _cached_result(manifest_path: Path, html_path: Path, pdf_path: Path) -> dict[str, Any] | None:
    if not manifest_path.is_file() or not html_path.is_file() or not pdf_path.is_file():
        return None
    try:
        manifest = _read_object(manifest_path, "缓存报告 manifest")
        manifest_files = manifest.get("files", [])
        if not isinstance(manifest_files, list):
            return None
        for path in (html_path, pdf_path):
            relative_path = path.relative_to(manifest_path.parents[2]).as_posix()
            item = next(
                (
                    item
                    for item in manifest_files
                    if isinstance(item, dict)
                    and item.get("role") == "report"
                    and item.get("relative_path") == relative_path
                ),
                None,
            )
            if item is None or path.stat().st_size != item.get("size_bytes") or _sha256_file(path) != item.get("sha256"):
                return None
    except (StopIteration, OSError, ValueError, ReportFailure):
        return None
    artifact_id = manifest.get("artifact_id")
    if not isinstance(artifact_id, str):
        return None
    summary = manifest.get("summary", {})
    return {"status": manifest.get("status", "partial"), "summary": summary, "warnings": manifest.get("warnings", []), "qa": summary.get("qa", {}) if isinstance(summary, dict) else {}, "artifact_refs": [{"artifact_id": artifact_id, "artifact_type": REPORT_ARTIFACT_TYPE, "status": manifest.get("status", "partial"), "manifest_relative_path": manifest_path.relative_to(manifest_path.parents[2]).as_posix()}], "cached": True}


def _restrict_narrative_charts(
    narratives: dict[str, dict[str, Any]], charts: list[SourceFile]
) -> dict[str, dict[str, Any]]:
    valid = {chart.chart_id for chart in charts if chart.chart_id}
    return {
        section_id: {**value, "chart_refs": [item for item in value.get("chart_refs", []) if item in valid]}
        for section_id, value in narratives.items()
    }


def generate_report(request: dict[str, Any], *, artifact_root: Path, job_id: str, progress: Any = None) -> dict[str, Any]:
    normalized, missing = _normalize_request(request)
    if missing:
        questions = []
        for key in missing:
            questions.append({"id": f"source_artifact_ids.{key}", "question": f"请提供报告所需的 {key} 公共 Artifact ID。", "options": [], "allow_free_text": True, "required": True})
        return {"status": "needs_input", "required_inputs": questions, "warnings": ["报告类型已确定，但缺少必需的公开 Artifact ID。"]}
    if progress:
        progress("validating_report_sources", 0, 4, [])
    sources = {key: load_source(artifact_root, key, artifact_id) for key, artifact_id in normalized["source_artifact_ids"].items()}
    warnings = _compatibility(sources, normalized["report_type"])
    facts = build_facts(sources)
    if progress:
        progress("building_report_facts", 1, 4, warnings)
    charts, chart_warnings = _select_charts(normalized["report_type"], sources)
    warnings = _unique([*warnings, *chart_warnings])
    if progress:
        progress("selecting_verified_charts", 2, 4, warnings)
    codex_narratives, narrative_warnings = _validate_narratives(
        normalized["narrative_blocks"], normalized["report_type"], sources, facts, charts
    )
    warnings = _unique([*warnings, *narrative_warnings])
    fallback_narratives = _fallback_narratives(normalized["report_type"], sources, facts, charts, warnings)
    narratives = {**fallback_narratives, **codex_narratives}
    narratives = _restrict_narrative_charts(narratives, charts)
    title = normalized["title"] or _default_title(normalized["report_type"], sources)
    fingerprint = {
        "report_type": normalized["report_type"],
        "title": title,
        "sources": {key: {"artifact_id": source.artifact_id, "manifest_sha256": source.manifest_sha256} for key, source in sources.items()},
        "narrative_blocks": narratives,
        "narrative_validation_warnings": narrative_warnings,
        "narrative_policy_version": NARRATIVE_POLICY_VERSION,
        "visual_policy_version": VISUAL_POLICY_VERSION,
        "report_config": normalized["report_config"],
    }
    artifact_id = f"artifact-{_sha256_bytes(_json_bytes(fingerprint))[:32]}"
    public_root = artifact_root.resolve(strict=True) / "public-artifacts" / artifact_id
    manifest_path = public_root / "manifest.json"
    html_path = public_root / "report.html"
    pdf_path = public_root / "report.pdf"
    cached = _cached_result(manifest_path, html_path, pdf_path)
    if cached is not None:
        if progress:
            progress("reusing_cached_report", 4, 4, cached.get("warnings", []))
        return cached
    status = "partial" if warnings else "succeeded"

    def render_formats() -> tuple[list[dict[str, Any]], bytes, bytes]:
        current_sections = build_sections(normalized["report_type"], sources, facts, charts, narratives, warnings)
        html_bytes = render_html(title, normalized["report_type"], status, sources, current_sections, warnings)
        pdf_bytes = render_pdf(title, normalized["report_type"], status, sources, current_sections, warnings)
        return current_sections, html_bytes, pdf_bytes

    sections, rendered, rendered_pdf = render_formats()
    while (len(rendered) > MAX_REPORT_BYTES or len(rendered_pdf) > MAX_PDF_BYTES) and charts:
        largest = max(charts, key=lambda item: item.size_bytes)
        charts = [item for item in charts if item != largest]
        narratives = _restrict_narrative_charts(narratives, charts)
        warnings = _unique([*warnings, f"图表 {largest.chart_id or largest.relative_path} 因 HTML/PDF 大小限制未嵌入。"])
        status = "partial"
        sections, rendered, rendered_pdf = render_formats()
    chart_count = sum(len(section.get("charts", [])) for section in sections)
    visual_count = sum(len(section.get("charts", [])) + len(section.get("tables", [])) for section in sections)
    narrative_stats = _narrative_stats(sections)
    html_qa = _qa_html(rendered, chart_count, narrative_stats["block_count"], visual_count)
    pdf_qa = _qa_pdf(rendered_pdf, chart_count, narrative_stats["block_count"], visual_count)
    if len(rendered) > MAX_REPORT_BYTES or len(rendered_pdf) > MAX_PDF_BYTES:
        raise ReportFailure("REPORT_TOO_LARGE", "报告在移除超限图表后仍超过 20 MB。")
    qa = {
        **html_qa,
        "html_size_bytes": len(rendered),
        "pdf_size_bytes": len(rendered_pdf),
        "combined_size_bytes": len(rendered) + len(rendered_pdf),
        "pdf": pdf_qa,
        "narrative": narrative_stats,
    }
    # ArtifactManifest.source_ids are upload/source refs, not upstream Artifact
    # IDs. The server verifies this list against session ownership during
    # registration; upstream Artifact IDs remain in summary.sources.
    source_ids = _unique([source_id for source in sources.values() for source_id in source.source_ids])
    summary = {
        "report_type": normalized["report_type"],
        "title": title,
        "template_version": normalized["report_config"]["template_version"],
        "renderer_version": normalized["report_config"]["renderer_version"],
        "chart_registry_version": normalized["report_config"]["chart_registry_version"],
        "visual_policy_version": VISUAL_POLICY_VERSION,
        "typography": {
            "body_font": f"{PDF_CJK_FONT_NAME} {PDF_BODY_FONT_SIZE}pt",
            "latin_font": "Times New Roman",
            "title_font": f"{PDF_CJK_FONT_NAME}（加大层级）",
        },
        "formats": ["html", "pdf"],
        "narrative": narrative_stats,
        "section_ids": [item[0] for item in SECTION_SKELETONS[normalized["report_type"]]],
        "sources": {key: {"artifact_id": source.artifact_id, "artifact_type": source.artifact_type, "status": source.status, "manifest_sha256": source.manifest_sha256, "time_range": list(_time_range(source.summary)), "target_point_id": _target_id(source)} for key, source in sources.items()},
        "selected_charts": [{"artifact_id": next(source.artifact_id for source in sources.values() if item.path.is_relative_to(source.root / "public-artifacts" / source.artifact_id)), "chart_id": item.chart_id, "sha256": item.sha256, "size_bytes": item.size_bytes} for item in charts],
        "qa": qa,
    }
    if progress:
        progress("rendering_report_formats", 3, 4, warnings)
    _atomic_bytes(html_path, rendered)
    _atomic_bytes(pdf_path, rendered_pdf)
    root = artifact_root.resolve(strict=True)
    manifest = {
        "schema_version": "1.0",
        "artifact_id": artifact_id,
        "artifact_type": REPORT_ARTIFACT_TYPE,
        "producer": {"skill_name": "building-energy-report-generation", "job_id": job_id},
        "source_ids": source_ids,
        "status": status,
        "files": [
            {"relative_path": html_path.relative_to(root).as_posix(), "media_type": "text/html; charset=utf-8", "size_bytes": len(rendered), "sha256": _sha256_file(html_path), "role": "report"},
            {"relative_path": pdf_path.relative_to(root).as_posix(), "media_type": "application/pdf", "size_bytes": len(rendered_pdf), "sha256": _sha256_file(pdf_path), "role": "report"},
        ],
        "summary": summary,
        "warnings": warnings,
    }
    _atomic_json(manifest_path, manifest)
    if progress:
        progress("validating_report_artifact", 4, 4, warnings)
    return {"status": status, "report_type": normalized["report_type"], "summary": summary, "artifact_refs": [{"artifact_id": artifact_id, "artifact_type": REPORT_ARTIFACT_TYPE, "status": status, "manifest_relative_path": manifest_path.relative_to(root).as_posix()}], "warnings": warnings, "qa": qa}


__all__ = ["ReportFailure", "build_facts", "generate_report", "load_source", "render_html", "render_pdf"]
