from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from .bundle import DatasetBundle
from .models import (
    AggregatedIssue,
    DimensionResult,
    EffectiveScope,
    QualityProfile,
    QualityResult,
    VariableRule,
)
from .util import content_id


@dataclass
class VariableStats:
    rule: VariableRule
    frame: pd.DataFrame
    expected: int
    nulls: int
    missing_timestamps: int
    duplicates: int
    anomaly_mask: pd.Series
    anomaly_reasons: dict[str, int] = field(default_factory=dict)

    @property
    def anomaly_count(self) -> int:
        return int(self.anomaly_mask.sum())

    @property
    def valid(self) -> pd.Series:
        return self.frame.loc[~self.anomaly_mask, "value_raw"].dropna()


def piecewise_score(rate: float) -> float:
    rate = max(0.0, min(1.0, float(rate)))
    percent = rate * 100
    if percent < 5:
        return 100 - 20 * percent / 5
    if percent < 10:
        return 80 - 10 * (percent - 5) / 5
    if percent < 20:
        return 70 - 10 * (percent - 10) / 10
    if percent < 100:
        return 60 - 60 * (percent - 20) / 80
    return 0.0


def entropy_score(values: pd.Series, bins: str | int, discrete: bool = False) -> float | None:
    values = values.dropna()
    if len(values) < 2:
        return None
    if discrete:
        counts = values.value_counts().to_numpy(dtype=float)
    else:
        try:
            counts, _ = np.histogram(values.to_numpy(dtype=float), bins=bins)
        except ValueError:
            return None
        counts = counts[counts > 0]
    m = len(counts)
    if m <= 1:
        return 0.0
    probabilities = counts / counts.sum()
    entropy = float(-(probabilities * np.log2(probabilities)).sum())
    return (entropy / math.log2(m)) ** 2 * 100


def _severity(profile: QualityProfile, ratio: float, duration_hours: float = 0) -> str:
    if ratio >= profile.severity.critical_ratio or duration_hours >= profile.severity.critical_duration_hours:
        return "critical"
    if ratio >= profile.severity.warning_ratio:
        return "warning"
    return "info"


def _issue(
    dimension: str,
    issue_type: str,
    summary: str,
    point_ids: list[str],
    count: int,
    ratio: float,
    profile: QualityProfile,
    action: str,
    duration_hours: float = 0,
) -> AggregatedIssue:
    return AggregatedIssue(
        dimension=dimension,
        issue_type=issue_type,
        summary=summary,
        affected_scope={
            "point_ids": sorted(set(point_ids)),
            "count": count,
            "ratio": round(ratio, 8),
            "duration_hours": round(duration_hours, 3),
        },
        severity=_severity(profile, ratio, duration_hours),
        recommended_action=action,
    )


def _variable_stats(bundle: DatasetBundle, rule: VariableRule, start: pd.Timestamp, end: pd.Timestamp) -> VariableStats:
    frame = bundle.load_points(rule.point_ids)
    frame = frame[(frame["timestamp"] >= start) & (frame["timestamp"] <= end)].copy()
    interval = pd.to_timedelta(rule.expected_interval_seconds, unit="s")
    expected_per_point = max(0, int((end - start) / interval) + 1)
    expected = expected_per_point * len(rule.point_ids)
    duplicates = int(frame.duplicated(["point_id", "timestamp"]).sum())
    unique_rows = frame.drop_duplicates(["point_id", "timestamp"], keep="first")
    nulls = int(unique_rows["value_raw"].isna().sum())
    existing = int(unique_rows[["point_id", "timestamp"]].drop_duplicates().shape[0])
    missing_timestamps = max(0, expected - existing)
    mask = pd.Series(False, index=frame.index)
    reasons: dict[str, int] = {}
    values = frame["value_raw"]
    if rule.valid_min is not None or rule.valid_max is not None:
        boundary = values.notna()
        if rule.valid_min is not None:
            boundary &= values < rule.valid_min
        else:
            boundary &= False
        if rule.valid_max is not None:
            boundary |= values.notna() & (values > rule.valid_max)
        count = int(boundary.sum())
        if count:
            reasons["OUT_OF_RANGE"] = count
            mask |= boundary
    if rule.allowed_values is not None:
        invalid = values.notna() & ~values.isin(rule.allowed_values)
        count = int(invalid.sum())
        if count:
            reasons["INVALID_ENUM"] = count
            mask |= invalid
    if rule.variable_type == "continuous":
        clean = values.dropna()
        if len(clean) >= 8:
            q1, q3 = clean.quantile([0.25, 0.75])
            iqr = q3 - q1
            if iqr > 0:
                distribution = values.notna() & ((values < q1 - 3 * iqr) | (values > q3 + 3 * iqr))
                count = int(distribution.sum())
                if count:
                    reasons["ROBUST_IQR_OUTLIER"] = count
                    mask |= distribution
    return VariableStats(rule, frame, expected, nulls, missing_timestamps, duplicates, mask, reasons)


def _available(score: float, summary: str) -> DimensionResult:
    return DimensionResult(status="available", score=round(max(0, min(100, score)), 4), summary=summary)


def _unavailable(reason: str, summary: str) -> DimensionResult:
    return DimensionResult(status="unavailable", score=None, summary=summary, reason_code=reason)


def assess(bundle: DatasetBundle, profile: QualityProfile) -> QualityResult:
    start = pd.Timestamp(bundle.manifest.time_start)
    end = pd.Timestamp(bundle.manifest.time_end)
    if start.tzinfo is None:
        start = start.tz_localize("UTC")
    if end.tzinfo is None:
        end = end.tz_localize("UTC")
    active = [rule for rule in profile.variables if rule.point_ids]
    stats = [_variable_stats(bundle, rule, start, end) for rule in active]
    by_role = {item.rule.role: item for item in stats}
    issues: list[AggregatedIssue] = []
    dimensions: dict[str, DimensionResult] = {}

    weight_total = sum(item.rule.weight for item in stats)
    missing_rate = (
        sum(item.rule.weight * (item.nulls + item.missing_timestamps) / item.expected for item in stats if item.expected)
        / weight_total if weight_total else 1.0
    )
    dimensions["DQ1"] = _available(piecewise_score(missing_rate), f"加权缺失率 {missing_rate:.2%}。")
    missing_points = [item.rule.role for item in stats if item.nulls + item.missing_timestamps]
    if missing_points:
        duration = max((item.missing_timestamps * item.rule.expected_interval_seconds / 3600 for item in stats), default=0)
        issues.append(_issue("DQ1", "MISSING_OBSERVATIONS", f"存在空值或缺失时间戳，加权缺失率 {missing_rate:.2%}。", missing_points, sum(i.nulls + i.missing_timestamps for i in stats), missing_rate, profile, "核对采集链路和整段取数缺口；不要伪造目标值。", duration))

    anomaly_rate = (
        sum(item.rule.weight * item.anomaly_count / max(1, len(item.frame)) for item in stats) / weight_total
        if weight_total else 1.0
    )
    dimensions["DQ2"] = _available(piecewise_score(anomaly_rate), f"去重规则命中后的加权异常率 {anomaly_rate:.2%}。")
    reason_groups: dict[str, list[VariableStats]] = {}
    for item in stats:
        for reason in item.anomaly_reasons:
            reason_groups.setdefault(reason, []).append(item)
    for reason, affected in reason_groups.items():
        count = sum(item.anomaly_reasons[reason] for item in affected)
        denominator = max(1, sum(len(item.frame) for item in affected))
        ratio = count / denominator
        issues.append(_issue("DQ2", reason, f"{reason} 共命中 {count} 条观测。", [i.rule.role for i in affected], count, ratio, profile, "核对设备协议、物理边界和运行工况，保留原值并在处理层添加质量标记。"))

    group_scores: list[float] = []
    missing_roles: list[str] = []
    for group in profile.expected_feature_groups:
        present = sum(bool(by_role.get(role) and len(by_role[role].frame["value_raw"].dropna())) for role in group.roles)
        group_scores.append(present / len(group.roles))
        missing_roles.extend(role for role in group.roles if role not in by_role or by_role[role].frame["value_raw"].dropna().empty)
    dq3 = float(np.mean(group_scores) * 100) if group_scores else 0
    dimensions["DQ3"] = _available(dq3, f"预期特征组平均覆盖率 {dq3:.2f}%。")
    if missing_roles:
        ratio = len(missing_roles) / sum(len(g.roles) for g in profile.expected_feature_groups)
        issues.append(_issue("DQ3", "MISSING_EXPECTED_FEATURES", f"缺少 {len(missing_roles)} 个预期语义角色。", missing_roles, len(missing_roles), ratio, profile, "补充目标相关点位或确认语义映射。"))

    range_scores: list[float] = []
    valid_timestamps: list[pd.Timestamp] = []
    for rule in profile.variables:
        item = by_role.get(rule.role)
        if not item or item.valid.empty:
            continue
        valid_timestamps.extend(item.frame.loc[item.frame["value_raw"].notna(), "timestamp"].tolist())
        if rule.valid_min is None or rule.valid_max is None:
            continue
        range_scores.append(min(1.0, (float(item.valid.max()) - float(item.valid.min())) / (rule.valid_max - rule.valid_min)))
    dq41 = float(np.mean(range_scores) * 100) if range_scores else None
    if valid_timestamps:
        valid_days = (max(valid_timestamps) - min(valid_timestamps)).total_seconds() / 86400
        dq42 = min(1.0, valid_days / profile.expected_duration_days) * 100
    else:
        dq42 = 0.0
    dq4 = (
        profile.theta4 * dq41 + (1 - profile.theta4) * dq42
        if dq41 is not None
        else dq42
    )
    dimensions["DQ4"] = _available(
        dq4,
        (
            f"值域覆盖 {dq41:.2f}%，时间尺度覆盖 {dq42:.2f}%。"
            if dq41 is not None
            else f"未配置可用值域规则，仅评估时间尺度覆盖 {dq42:.2f}%。"
        ),
    )

    target = by_role.get("target")
    correlations: list[tuple[float, float]] = []
    alignments: list[tuple[float, float]] = []
    if target and len(target.frame["value_raw"].dropna()) >= 3:
        target_frame = target.frame[["timestamp", "value_raw"]].dropna().sort_values("timestamp").rename(columns={"value_raw": "target"})
        for item in stats:
            if item.rule.role == "target" or len(item.frame["value_raw"].dropna()) < 3:
                continue
            feature = item.frame[["timestamp", "value_raw"]].dropna().sort_values("timestamp").rename(columns={"value_raw": "feature"})
            merged = pd.merge_asof(
                target_frame, feature, on="timestamp", direction="nearest",
                tolerance=pd.to_timedelta(profile.alignment_tolerance_seconds, unit="s"),
            )
            aligned = merged["feature"].notna()
            alignments.append((item.rule.weight, float(aligned.mean())))
            paired = merged.loc[aligned, ["target", "feature"]]
            if len(paired) >= 3 and paired["target"].nunique() > 1 and paired["feature"].nunique() > 1:
                correlation = spearmanr(paired["target"], paired["feature"]).statistic
                if np.isfinite(correlation):
                    correlations.append((item.rule.weight, abs(float(correlation))))
    if not target or len(target.frame["value_raw"].dropna()) < 3:
        dimensions["DQ5"] = _unavailable("INSUFFICIENT_TARGET_SAMPLES", "目标有效样本不足，无法计算一致性。")
    elif not correlations:
        dimensions["DQ5"] = _unavailable("INSUFFICIENT_PAIRED_SAMPLES", "没有足够的目标—特征有效配对样本。")
    else:
        dq51 = sum(w * c for w, c in correlations) / sum(w for w, _ in correlations) * 100
        target_times = target.frame["timestamp"].dropna().sort_values()
        diffs = target_times.drop_duplicates().diff().dropna().dt.total_seconds()
        expected_interval = target.rule.expected_interval_seconds
        sigma = float(diffs.std() / expected_interval) if len(diffs) > 1 and np.isfinite(diffs.std()) else 0
        rm = (target.nulls + target.missing_timestamps) / max(1, target.expected)
        rd = target.duplicates / max(1, len(target.frame))
        ra = sum(w * a for w, a in alignments) / sum(w for w, _ in alignments) if alignments else 0
        penalties = profile.time_penalties
        dq52 = max(0.0, 1 - penalties["interval_std"] * sigma - penalties["missing"] * rm - penalties["duplicate"] * rd - penalties["alignment"] * (1 - ra)) * 100
        dq5 = profile.theta5 * dq51 + (1 - profile.theta5) * dq52
        dimensions["DQ5"] = _available(dq5, f"逻辑一致性 {dq51:.2f}%，时间一致性 {dq52:.2f}%。")
        if rd:
            issues.append(_issue("DQ5", "DUPLICATE_TIMESTAMPS", f"目标存在 {target.duplicates} 个重复时间戳。", target.rule.point_ids, target.duplicates, rd, profile, "核对采集主键并保留可追溯去重规则。"))
        if ra < 1:
            issues.append(_issue("DQ5", "TIME_ALIGNMENT_GAPS", f"特征与目标时间容差对齐率 {ra:.2%}。", [i.rule.role for i in stats if i.rule.role != "target"], round((1-ra)*len(target_frame)), 1-ra, profile, "核对原生采样频率与时间容差，不在质量评估中重采样原值。"))

    entropies: list[tuple[float, float]] = []
    for item in stats:
        score = entropy_score(item.valid, profile.entropy_bins, item.rule.variable_type != "continuous")
        if score is not None:
            entropies.append((item.rule.weight, score))
    if not entropies:
        dimensions["DQ6"] = _unavailable("INSUFFICIENT_VALID_SAMPLES", "没有变量具备计算信息熵所需的有效样本。")
    else:
        dq6 = sum(weight * score for weight, score in entropies) / sum(weight for weight, _ in entropies)
        dimensions["DQ6"] = _available(dq6, f"{len(entropies)} 个变量参与信息熵评分。")

    available = all(item.status == "available" for item in dimensions.values())
    overall = (
        sum(profile.dimension_weights[name] * dimensions[name].score for name in profile.dimension_weights)
        if available else None
    )
    scope_ids = sorted({point_id for rule in active for point_id in rule.point_ids})
    identity = {
        "source_bundle_id": bundle.manifest.dataset_bundle_id,
        "quality_profile_id": profile.quality_profile_id,
        "assessment_context": profile.assessment_context.model_dump(mode="json"),
    }
    assessment_id = content_id("qa", identity)
    severity_order = {"critical": 0, "warning": 1, "info": 2}
    issues.sort(key=lambda issue: (severity_order[issue.severity], issue.dimension, issue.issue_type))
    return QualityResult(
        assessment_id=assessment_id,
        source_bundle_id=bundle.manifest.dataset_bundle_id,
        assessment_context=profile.assessment_context,
        formula_version=profile.formula_version,
        quality_profile_id=profile.quality_profile_id or "",
        effective_scope=EffectiveScope(
            included_point_count=len(scope_ids), time_start=start.isoformat(), time_end=end.isoformat(),
            included_point_ids=scope_ids,
        ),
        dimensions=dimensions,
        overall_score=round(overall, 4) if overall is not None else None,
        issues=issues,
    )
