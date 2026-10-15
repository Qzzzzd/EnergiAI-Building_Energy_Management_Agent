from __future__ import annotations

import pandas as pd
import pytest

from data_quality_assessment.bundle import load_dataset_bundle
from data_quality_assessment.engine import _variable_stats, entropy_score, piecewise_score, assess
from data_quality_assessment.models import AssessmentContext
from data_quality_assessment.errors import QualityError
from data_quality_assessment.profile import build_mvp_profile, finalize_profile, validate_point_mappings
from create_fixture import create_fixture


@pytest.mark.parametrize(
    ("rate", "expected"),
    [(0, 100), (0.05, 80), (0.10, 70), (0.20, 60), (1, 0)],
)
def test_piecewise_boundaries(rate: float, expected: float) -> None:
    assert piecewise_score(rate) == pytest.approx(expected)


def test_entropy_uniform_and_constant() -> None:
    assert entropy_score(pd.Series([0, 1, 0, 1]), 2, True) == pytest.approx(100)
    assert entropy_score(pd.Series([1, 1, 1, 1]), 2, True) == 0


def test_profile_id_is_content_hash(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, unresolved = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    assert not unresolved
    assert profile.quality_profile_id.startswith("qprofile-")
    assert finalize_profile(profile).quality_profile_id == profile.quality_profile_id


def test_generated_profile_uses_catalog_interval_and_skill1_encodings(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    points = bundle.points.copy()
    points.loc[points["point_id"] == "chiller-state", "expected_interval_seconds"] = 120
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, unresolved = build_mvp_profile(
        bundle.manifest.schema_fingerprint,
        context,
        points,
        {"state_encodings": {"chiller-state": {"自动": 42.0}}},
    )

    assert not unresolved
    rule = next(item for item in profile.variables if item.role == "chiller_state")
    assert rule.expected_interval_seconds == 120
    assert rule.allowed_values == [0.0, 1.0, 42.0]


def test_generated_profile_maps_project_acceptance_semantics() -> None:
    points = pd.DataFrame(
        [
            ("wet-bulb", "1#湿球温度", "湿球温度", "continuous", "℃", 60),
            ("chw-supply", "M1-C501-CH01", "冷冻水出水温度", "continuous", "℃", 60),
            ("chw-return", "M1-C501-CH01", "冷冻水进水温度", "continuous", "℃", 60),
            ("chiller-state", "M1-C501-CH01", "冷机运行状态", "state", "0=关闭;1=运行", 300),
            ("room-temperature", "HE1.C.IT201", "包间_冷通道温湿度_温度_平均值", "continuous", "℃", 60),
            ("it-power", "HE1.C", "楼栋-IT总功率", "continuous", "kW", 60),
            ("chiller-power", "HE1.C", "楼栋_水冷冷水机组_冷机输出功率__总和", "continuous", "kW", 60),
            ("target-load", "HE1.C", "楼栋_水冷冷水机组_冷机制冷量__总和", "continuous", "kW", 60),
        ],
        columns=[
            "point_id",
            "name",
            "description",
            "variable_type",
            "unit",
            "expected_interval_seconds",
        ],
    )
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")

    profile, unresolved = build_mvp_profile("acceptance-schema", context, points)

    assert not unresolved
    mappings = {rule.role: rule.point_ids for rule in profile.variables}
    assert mappings["it_power"] == ["it-power"]
    assert mappings["chilled_supply_temperature"] == ["chw-supply"]
    assert mappings["chilled_return_temperature"] == ["chw-return"]
    assert mappings["room_temperature"] == ["room-temperature"]
    assert mappings["chiller_power"] == ["chiller-power"]
    assert mappings["chiller_state"] == ["chiller-state"]
    validate_point_mappings(profile, points)


def test_unmapped_catalog_points_are_included(tmp_path) -> None:
    create_fixture(tmp_path, "fixture", point_count=10)
    points_path = tmp_path / "dataset-bundles" / "fixture" / "points.parquet"
    points = pd.read_parquet(points_path)
    points.loc[points["point_id"] == "extra-009", ["name", "description"]] = ["unknown signal", "unknown signal"]
    points.to_parquet(points_path, index=False)
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")

    profile, unresolved = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)

    assert not unresolved
    generic = next(rule for rule in profile.variables if rule.role == "point:extra-009")
    assert generic.point_ids == ["extra-009"]
    result = assess(bundle, profile)
    assert result.effective_scope.included_point_count == 10


def test_unencoded_state_point_is_assessable(tmp_path) -> None:
    create_fixture(tmp_path, "fixture", point_count=10)
    points_path = tmp_path / "dataset-bundles" / "fixture" / "points.parquet"
    points = pd.read_parquet(points_path)
    points.loc[points["point_id"] == "extra-009", ["name", "description", "variable_type", "unit"]] = [
        "unknown state", "unknown state", "state", None,
    ]
    points.to_parquet(points_path, index=False)
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")

    profile, unresolved = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)

    assert not unresolved
    generic = next(rule for rule in profile.variables if rule.role == "point:extra-009")
    assert generic.variable_type == "state"
    assert generic.allowed_values is None
    assert assess(bundle, profile).dimensions["DQ6"].status == "available"


def test_six_dimensions_and_deduplicated_anomalies(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, unresolved = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    assert not unresolved
    result = assess(bundle, profile)
    assert set(result.dimensions) == {f"DQ{i}" for i in range(1, 7)}
    assert all(item.status == "available" for item in result.dimensions.values())
    assert result.overall_score is not None
    assert any(issue.issue_type == "INVALID_ENUM" for issue in result.issues)
    assert any(issue.issue_type == "DUPLICATE_TIMESTAMPS" for issue in result.issues)
    assert result.effective_scope.included_point_count == 9


def test_unavailable_suppresses_overall(tmp_path) -> None:
    create_fixture(tmp_path, "fixture", periods=2)
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, _ = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    result = assess(bundle, profile)
    assert result.dimensions["DQ5"].status == "unavailable"
    assert result.overall_score is None


def test_profile_rejects_unknown_point_mapping(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, _ = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    variables = list(profile.variables)
    variables[0] = variables[0].model_copy(update={"point_ids": ["does-not-exist"]})
    invalid = profile.model_copy(update={"quality_profile_id": None, "variables": variables})
    with pytest.raises(QualityError, match="PROFILE_POINT_MAPPING_INCOMPATIBLE"):
        validate_point_mappings(invalid, bundle.points)


def test_eighteen_day_absent_interval_is_counted(tmp_path) -> None:
    import json
    create_fixture(tmp_path, "fixture")
    manifest_path = tmp_path / "dataset-bundles" / "fixture" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["time_end"] = (pd.Timestamp(manifest["time_end"]) + pd.to_timedelta(18, unit="D")).isoformat()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, _ = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    result = assess(bundle, profile)
    assert result.dimensions["DQ1"].score < 10
    issue = next(issue for issue in result.issues if issue.issue_type == "MISSING_OBSERVATIONS")
    assert issue.severity == "critical"
    assert issue.affected_scope["duration_hours"] >= 18 * 24


def test_anomaly_union_counts_one_observation_once(tmp_path) -> None:
    create_fixture(tmp_path, "fixture")
    bundle = load_dataset_bundle(tmp_path, "fixture")
    context = AssessmentContext(task_type="load_forecasting", target_point_id="target-load")
    profile, _ = build_mvp_profile(bundle.manifest.schema_fingerprint, context, bundle.points)
    rule = next(rule for rule in profile.variables if rule.role == "chiller_power")
    stats = _variable_stats(
        bundle,
        rule,
        pd.Timestamp(bundle.manifest.time_start),
        pd.Timestamp(bundle.manifest.time_end),
    )
    assert sum(stats.anomaly_reasons.values()) > stats.anomaly_count
