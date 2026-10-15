from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AssessmentContext(StrictModel):
    task_type: Literal["load_forecasting"]
    target_point_id: str = Field(min_length=1)


class QualityAssessmentSpec(StrictModel):
    source_bundle_id: str = Field(min_length=1, pattern=r"^[A-Za-z0-9._-]+$")
    assessment_context: AssessmentContext
    quality_profile_id: str | None = None


class DatasetBundleManifest(StrictModel):
    bundle_type: Literal["DatasetBundle"]
    bundle_version: Literal["0.7"]
    dataset_bundle_id: str
    schema_fingerprint: str
    time_start: str
    time_end: str


class ParameterProvenance(StrictModel):
    parameter: str
    value: Any
    source_type: Literal[
        "dataset_catalog",
        "project_material",
        "industry_standard",
        "user_confirmed",
        "agent_inferred",
    ]
    basis: str
    confidence: Literal["low", "medium", "high"]


class FeatureExpectation(StrictModel):
    group: str
    roles: list[str] = Field(min_length=1)


class VariableRule(StrictModel):
    role: str
    point_ids: list[str] = Field(default_factory=list)
    semantic_patterns: list[str] = Field(default_factory=list)
    variable_type: Literal["continuous", "state", "enum"] = "continuous"
    unit: str | None = None
    valid_min: float | None = None
    valid_max: float | None = None
    allowed_values: list[float] | None = None
    expected_interval_seconds: int = Field(default=60, gt=0)
    weight: float = Field(default=1.0, gt=0)
    required: bool = True

    @model_validator(mode="after")
    def validate_rule(self) -> "VariableRule":
        if self.valid_min is not None and self.valid_max is not None and self.valid_min >= self.valid_max:
            raise ValueError("valid_min must be less than valid_max")
        return self


class SeverityConfig(StrictModel):
    warning_ratio: float = Field(default=0.01, ge=0, le=1)
    critical_ratio: float = Field(default=0.10, ge=0, le=1)
    critical_duration_hours: float = Field(default=24.0, ge=0)


class QualityProfile(StrictModel):
    quality_profile_id: str | None = None
    formula_version: Literal["dq-v1"] = "dq-v1"
    locale: Literal["zh-CN"] = "zh-CN"
    assessment_context: AssessmentContext
    dataset_schema_fingerprint: str
    target_mapping: dict[str, str] = Field(default_factory=dict)
    expected_feature_groups: list[FeatureExpectation]
    variables: list[VariableRule]
    dimension_weights: dict[str, float] = Field(
        default_factory=lambda: {
            "DQ1": 0.20, "DQ2": 0.20, "DQ3": 0.05,
            "DQ4": 0.05, "DQ5": 0.20, "DQ6": 0.30,
        }
    )
    theta4: float = Field(default=0.7, ge=0, le=1)
    expected_duration_days: float = Field(default=116.0, gt=0)
    theta5: float = Field(default=0.7, ge=0, le=1)
    time_penalties: dict[str, float] = Field(
        default_factory=lambda: {"interval_std": 0.5, "missing": 0.3, "duplicate": 0.3, "alignment": 0.5}
    )
    alignment_tolerance_seconds: int = Field(default=300, ge=0)
    entropy_bins: Literal["fd", "sturges"] | int = "fd"
    severity: SeverityConfig = Field(default_factory=SeverityConfig)
    parameter_provenance: list[ParameterProvenance] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_weights(self) -> "QualityProfile":
        expected = {f"DQ{i}" for i in range(1, 7)}
        if set(self.dimension_weights) != expected or abs(sum(self.dimension_weights.values()) - 1.0) > 1e-9:
            raise ValueError("dimension_weights must contain DQ1..DQ6 and sum to 1")
        if self.severity.warning_ratio > self.severity.critical_ratio:
            raise ValueError("warning_ratio cannot exceed critical_ratio")
        return self


class AggregatedIssue(StrictModel):
    dimension: str
    issue_type: str
    summary: str
    affected_scope: dict[str, Any]
    severity: Literal["info", "warning", "critical"]
    recommended_action: str


class DimensionResult(StrictModel):
    status: Literal["available", "unavailable"]
    score: float | None
    summary: str
    reason_code: str | None = None


class EffectiveScope(StrictModel):
    included_point_count: int
    time_start: str
    time_end: str
    included_point_ids: list[str]


class QualityResult(StrictModel):
    assessment_id: str
    source_bundle_id: str
    assessment_context: AssessmentContext
    formula_version: str
    quality_profile_id: str
    effective_scope: EffectiveScope
    dimensions: dict[str, DimensionResult]
    overall_score: float | None
    issues: list[AggregatedIssue]


class QualityAssessmentBundleManifest(StrictModel):
    bundle_type: Literal["QualityAssessmentBundle"] = "QualityAssessmentBundle"
    bundle_version: Literal["0.7"] = "0.7"
    quality_assessment_bundle_id: str
    assessment_id: str
    source_bundle_id: str
    formula_version: str
    quality_profile_id: str
    created_at: str
    files: dict[str, str]
