from __future__ import annotations

import re
from typing import Any

import pandas as pd

from .errors import QualityError
from .models import (
    AssessmentContext,
    FeatureExpectation,
    ParameterProvenance,
    QualityProfile,
    VariableRule,
)
from .util import content_id


def finalize_profile(profile: QualityProfile) -> QualityProfile:
    payload = profile.model_dump(exclude={"quality_profile_id"}, mode="json")
    expected_id = content_id("qprofile", payload)
    if profile.quality_profile_id and profile.quality_profile_id != expected_id:
        raise QualityError(
            "PROFILE_ID_MISMATCH",
            "QualityProfile ID does not match its immutable content.",
            {"expected": expected_id, "actual": profile.quality_profile_id},
        )
    return profile.model_copy(update={"quality_profile_id": expected_id})


def _search(points: pd.DataFrame, patterns: list[str]) -> list[str]:
    columns = [column for column in ["point_id", "name", "description", "original_column_name"] if column in points]
    text = points[columns].fillna("").astype(str).agg(" ".join, axis=1)
    mask = pd.Series(False, index=points.index)
    for pattern in patterns:
        mask |= text.str.contains(re.escape(pattern), case=False, regex=True)
    return points.loc[mask, "point_id"].astype(str).tolist()


def _search_compatible(
    points: pd.DataFrame,
    patterns: list[str],
    variable_type: str,
    unit: str | None,
) -> list[str]:
    candidates = _search(points, patterns)
    compatible: list[str] = []
    for point_id in candidates:
        row = points.loc[points["point_id"].astype(str) == point_id].iloc[0]
        if _catalog_variable_type(row) != variable_type:
            continue
        source_unit = row.get("unit")
        if unit and pd.notna(source_unit) and str(source_unit).strip() and str(source_unit) != unit:
            continue
        compatible.append(point_id)
    return compatible


def _encoded_values(state_encodings: dict[str, Any], point_ids: list[str]) -> list[float]:
    encoded: set[float] = set()
    for point_id in point_ids:
        values = state_encodings.get(point_id, {})
        if not isinstance(values, dict):
            continue
        for value in values.values():
            try:
                encoded.add(float(value))
            except (TypeError, ValueError):
                continue
    return sorted(encoded)


def _catalog_variable_type(row: pd.Series) -> str:
    value = str(row.get("variable_type") or "continuous")
    return value if value in {"continuous", "state", "enum"} else "continuous"


def _catalog_unit(row: pd.Series) -> str | None:
    value = row.get("unit")
    return str(value) if pd.notna(value) and str(value).strip() else None


def _catalog_interval(row: pd.Series, fallback: int = 60) -> int:
    value = row.get("expected_interval_seconds")
    return int(value) if pd.notna(value) else fallback


def build_mvp_profile(
    schema_fingerprint: str,
    context: AssessmentContext,
    points: pd.DataFrame,
    parse_report: dict[str, Any] | None = None,
) -> tuple[QualityProfile, list[dict[str, Any]]]:
    point_catalog = points.copy()
    point_catalog["point_id"] = point_catalog["point_id"].astype(str)
    point_catalog = point_catalog.set_index("point_id", drop=False)
    target_row = point_catalog.loc[context.target_point_id] if context.target_point_id in point_catalog.index else None
    target_unit = (
        str(target_row["unit"])
        if target_row is not None and pd.notna(target_row["unit"]) and str(target_row["unit"]).strip()
        else None
    )
    target_interval = (
        int(target_row["expected_interval_seconds"])
        if target_row is not None and pd.notna(target_row["expected_interval_seconds"])
        else 60
    )
    definitions = [
        ("it_power", ["IT设备总功率", "IT总功率", "IT功率", "IT power", "IT_power"], "continuous", "kW", 0, 10000, None, 60),
        ("dry_bulb", ["干球", "dry bulb", "dry_bulb"], "continuous", "℃", -50, 60, None, 60),
        ("wet_bulb", ["湿球", "wet bulb", "wet_bulb"], "continuous", "℃", -20, 40, None, 60),
        ("solar_radiation", ["太阳辐射", "solar radiation", "solar_radiation", "irradiance"], "continuous", None, 0, 2000, None, 60),
        ("relative_humidity", ["相对湿度", "relative humidity", "relative_humidity", "humidity"], "continuous", "%", 0, 100, None, 60),
        ("chilled_supply_temperature", ["冷冻水供水温度", "冷冻水出水温度"], "continuous", "℃", -10, 60, None, 60),
        ("chilled_return_temperature", ["冷冻水回水温度", "冷冻水进水温度"], "continuous", "℃", -10, 60, None, 60),
        ("room_temperature", ["房间温度", "冷通道温湿度_温度", "room temperature", "room_temperature"], "continuous", "℃", 0, 50, None, 60),
        ("chiller_power", ["总冷机电负荷", "冷机电负荷", "冷机输出功率", "chiller power", "chiller_power"], "continuous", "kW", 0, 1500, None, 60),
        ("chiller_state", ["冷机启停状态", "冷机运行状态", "chiller state", "chiller_state"], "state", None, None, None, [0, 1], 300),
        ("free_cooling_mode", ["免费制冷", "free cooling", "free_cooling"], "enum", None, None, None, [0, 1, 2, 3], 300),
    ]
    state_encodings = (parse_report or {}).get("state_encodings", {})
    if not isinstance(state_encodings, dict):
        state_encodings = {}
    point_ids = point_catalog["point_id"].astype(str).tolist()
    known_point_ids = set(point_ids)
    variables: list[VariableRule] = []
    unresolved: list[dict[str, Any]] = []
    target_exists = context.target_point_id in known_point_ids
    target_kind = _catalog_variable_type(target_row) if target_row is not None else "continuous"
    variables.append(
        VariableRule(
            role="target",
            point_ids=[context.target_point_id] if target_exists else [],
            semantic_patterns=[context.target_point_id],
            variable_type=target_kind,
            unit=target_unit,
            expected_interval_seconds=target_interval,
            weight=0.35,
            required=True,
        )
    )
    if not target_exists:
        unresolved.append({"parameter": "target_mapping.target", "reason": "TARGET_POINT_NOT_FOUND"})

    assigned = {context.target_point_id} if target_exists else set()
    for role, patterns, kind, unit, minimum, maximum, allowed, interval in definitions:
        candidates = [
            point_id
            for point_id in _search_compatible(points, patterns, kind, unit)
            if point_id not in assigned
        ]
        intervals = {
            _catalog_interval(point_catalog.loc[point_id])
            for point_id in candidates
            if point_id in point_catalog.index
        }
        if len(intervals) > 1:
            # A domain rule with mixed cadences is not high-confidence. Keep
            # the points for generic catalog rules instead of forcing a mapping.
            candidates = []
            intervals = set()
        effective_interval = interval
        if len(intervals) == 1:
            effective_interval = intervals.pop()
        effective_allowed = None if allowed is None else list(allowed)
        if effective_allowed is not None:
            effective_allowed = sorted(set(map(float, effective_allowed)) | set(_encoded_values(state_encodings, candidates)))
        variables.append(
            VariableRule(
                role=role, point_ids=candidates, semantic_patterns=patterns, variable_type=kind,
                unit=unit, valid_min=minimum, valid_max=maximum, allowed_values=effective_allowed,
                expected_interval_seconds=effective_interval, weight=0.01, required=False,
            )
        )
        assigned.update(candidates)

    for point_id in point_ids:
        if point_id in assigned:
            continue
        row = point_catalog.loc[point_id]
        kind = _catalog_variable_type(row)
        variables.append(
            VariableRule(
                role=f"point:{point_id}",
                point_ids=[point_id],
                variable_type=kind,
                unit=_catalog_unit(row),
                allowed_values=_encoded_values(state_encodings, [point_id]) or None,
                expected_interval_seconds=_catalog_interval(row),
                weight=0.01,
                required=False,
            )
        )

    non_target_count = sum(
        len(set(rule.point_ids)) for rule in variables if rule.role != "target" and rule.point_ids
    )
    for index, rule in enumerate(variables):
        if rule.role == "target":
            weight = 0.35 if non_target_count else 1.0
        elif rule.point_ids and non_target_count:
            weight = 0.65 * len(set(rule.point_ids)) / non_target_count
        else:
            weight = 0.01
        variables[index] = rule.model_copy(update={"weight": weight})

    actual_roles = [rule.role for rule in variables if rule.role != "target" and rule.point_ids]
    expected_feature_groups = [
        FeatureExpectation(group="目标与时间", roles=["target"]),
        FeatureExpectation(group="外部环境", roles=["dry_bulb", "wet_bulb", "solar_radiation", "relative_humidity"]),
        FeatureExpectation(group="负荷与功率", roles=["it_power", "chiller_power"]),
        FeatureExpectation(group="水系统", roles=["chilled_supply_temperature", "chilled_return_temperature"]),
        FeatureExpectation(group="室内环境", roles=["room_temperature"]),
        FeatureExpectation(group="运行状态", roles=["chiller_state", "free_cooling_mode"]),
    ]
    if actual_roles:
        expected_feature_groups.append(FeatureExpectation(group="数据集实际点位", roles=actual_roles))

    profile = QualityProfile(
        assessment_context=context,
        dataset_schema_fingerprint=schema_fingerprint,
        target_mapping={"target": context.target_point_id},
        expected_feature_groups=expected_feature_groups,
        variables=variables,
        parameter_provenance=[
            ParameterProvenance(
                parameter="expected_intervals",
                value="points.parquet values with project defaults as fallback",
                source_type="dataset_catalog",
                basis="优先使用 DatasetBundle 点位目录；未映射点位保留项目默认值。",
                confidence="high",
            ),
            ParameterProvenance(
                parameter="valid_ranges",
                value="high-confidence semantic rules with catalog fallback",
                source_type="agent_inferred",
                basis="仅对类型和单位兼容的高置信语义点位应用领域范围；其余实际点位保留通用质量检查。",
                confidence="medium",
            ),
            ParameterProvenance(
                parameter="free_cooling_mode.allowed_values",
                value=[0, 1, 2, 3],
                source_type="project_material",
                basis="数据分析报告确认预期编码。",
                confidence="high",
            ),
        ],
    )
    return finalize_profile(profile), unresolved


def ensure_compatible(profile: QualityProfile, schema_fingerprint: str, context: AssessmentContext) -> QualityProfile:
    profile = finalize_profile(profile)
    if profile.dataset_schema_fingerprint != schema_fingerprint:
        raise QualityError("PROFILE_SCHEMA_INCOMPATIBLE", "QualityProfile schema fingerprint is incompatible.")
    if profile.assessment_context != context:
        raise QualityError("PROFILE_CONTEXT_INCOMPATIBLE", "QualityProfile assessment context is incompatible.")
    return profile


def validate_point_mappings(profile: QualityProfile, points: pd.DataFrame) -> None:
    catalog = points.copy()
    catalog["point_id"] = catalog["point_id"].astype(str)
    catalog = catalog.set_index("point_id", drop=False)
    known = set(catalog.index)
    errors: list[dict[str, Any]] = []
    for rule in profile.variables:
        if rule.required and not rule.point_ids:
            errors.append({"role": rule.role, "reason": "REQUIRED_MAPPING_MISSING"})
        unknown = sorted(set(rule.point_ids) - known)
        if unknown:
            errors.append({"role": rule.role, "reason": "POINT_ID_NOT_FOUND", "point_ids": unknown})
        for point_id in set(rule.point_ids) & known:
            row = catalog.loc[point_id]
            source_type = str(row["variable_type"])
            if source_type != rule.variable_type:
                errors.append({
                    "role": rule.role, "point_id": point_id, "reason": "VARIABLE_TYPE_MISMATCH",
                    "expected": rule.variable_type, "actual": source_type,
                })
            source_unit = row["unit"]
            if rule.unit and pd.notna(source_unit) and str(source_unit).strip() and str(source_unit) != rule.unit:
                errors.append({
                    "role": rule.role, "point_id": point_id, "reason": "UNIT_MISMATCH",
                    "expected": rule.unit, "actual": str(source_unit),
                })
    target_id = profile.assessment_context.target_point_id
    target_rule = next((rule for rule in profile.variables if rule.role == "target"), None)
    if target_rule is None or target_id not in target_rule.point_ids:
        errors.append({"role": "target", "reason": "TARGET_MAPPING_MISMATCH", "target_point_id": target_id})
    if errors:
        raise QualityError("PROFILE_POINT_MAPPING_INCOMPATIBLE", "QualityProfile point mappings are incompatible.", {"errors": errors})
