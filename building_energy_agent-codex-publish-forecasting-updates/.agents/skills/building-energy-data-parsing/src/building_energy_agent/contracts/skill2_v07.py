"""Skill 2 public input/output contracts for V0.7."""

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from building_energy_agent.contracts.common import (
    JobStartResponse,
    JobStatusResponse,
    StrictContractModel,
)
from building_energy_agent.contracts.paths import (
    OpaqueBundleId,
    validate_bundle_relative_path,
)


class TargetSpec(StrictContractModel):
    """One prediction target selected by a stable point ID."""

    point_id: str = Field(min_length=1)


class PredictionSpec(StrictContractModel):
    """Prediction interval settings with the V0.7 default horizon."""

    forecast_horizon: str = Field(default="7d", min_length=1)


class FeatureSpec(StrictContractModel):
    """Feature engineering preset without a frozen feature list."""

    preset: str = Field(default="default", min_length=1)


class ProcessingSpec(StrictContractModel):
    """Structured Skill 2 request referencing a Skill 1 DatasetBundle."""

    source_bundle_id: OpaqueBundleId
    target: TargetSpec
    # The objects themselves are required even though their internal fields
    # currently have defaults.
    prediction_spec: PredictionSpec
    feature_spec: FeatureSpec
    data_scope: dict[str, Any] = Field(default_factory=dict)
    split_spec: dict[str, Any] = Field(default_factory=dict)
    missing_values: dict[str, Any] = Field(default_factory=dict)
    outliers: dict[str, Any] = Field(default_factory=dict)


class PredictionSample(StrictContractModel):
    """Minimum time identity shared by model-ready prediction samples."""

    sample_id: str = Field(min_length=1)
    feature_cutoff_timestamp: datetime
    forecast_start_timestamp: datetime
    forecast_end_timestamp: datetime

    @model_validator(mode="after")
    def cutoff_is_exclusive_forecast_boundary(self) -> "PredictionSample":
        if self.feature_cutoff_timestamp != self.forecast_start_timestamp:
            raise ValueError(
                "feature_cutoff_timestamp must equal forecast_start_timestamp"
            )
        if self.forecast_end_timestamp < self.forecast_start_timestamp:
            raise ValueError(
                "forecast_end_timestamp must not precede forecast_start_timestamp"
            )
        return self


class FeatureSetRow(BaseModel):
    """Logical wide FeatureSet row with unfrozen feature columns.

    Extra columns are deliberately retained because every such column is an
    actual wide-table feature. This is the only V0.7 input model that allows
    extras; unlike Pydantic's ignore behavior, values are preserved and visible
    in ``model_extra``.
    """

    model_config = ConfigDict(extra="allow")

    sample_id: str = Field(min_length=1)
    feature_cutoff_timestamp: datetime
    forecast_start_timestamp: datetime
    forecast_end_timestamp: datetime

    @model_validator(mode="after")
    def cutoff_is_exclusive_forecast_boundary(self) -> "FeatureSetRow":
        if self.feature_cutoff_timestamp != self.forecast_start_timestamp:
            raise ValueError(
                "feature_cutoff_timestamp must equal forecast_start_timestamp"
            )
        if self.forecast_end_timestamp < self.forecast_start_timestamp:
            raise ValueError(
                "forecast_end_timestamp must not precede forecast_start_timestamp"
            )
        return self


class ForecastIndexRow(StrictContractModel):
    """One target time and its known-in-advance forecast coordinates."""

    sample_id: str = Field(min_length=1)
    target_timestamp: datetime
    horizon_step: int = Field(ge=1)
    horizon_duration: str = Field(pattern=r"^(0|[1-9]\d*)min$")
    calendar_hour: int = Field(ge=0, le=23)
    calendar_weekday: int = Field(ge=0, le=6)
    calendar_month: int = Field(ge=1, le=12)



class LabelSetRow(StrictContractModel):
    """One target timestamp in the long LabelSet."""

    sample_id: str = Field(min_length=1)
    target_timestamp: datetime
    target_value: int | float | None


class FeatureCatalogEntry(StrictContractModel):
    """Minimum logical entry in feature_catalog.parquet."""

    feature_name: str = Field(min_length=1)
    data_type: Literal["numeric", "boolean", "categorical"]
    # A normal single-source feature uses an opaque point-id string. The
    # representation for features without one source point is intentionally
    # unfrozen, so this required field remains open.
    source_point_id: str | None
    semantic_version: str = Field(min_length=1)


class TargetMetadata(StrictContractModel):
    """Exact Skill 4-compatible target metadata."""

    target_point_id: Literal["总冷机冷负荷"] = "总冷机冷负荷"
    target_name: Literal["总冷机冷负荷"] = "总冷机冷负荷"
    target_unit: Literal["kW"] = "kW"
    source_target_point_id: str = Field(min_length=1)


class CategoricalMapping(StrictContractModel):
    """Frozen integer codes for one categorical feature."""

    unknown: int
    values: list[int] = Field(min_length=1)

    @model_validator(mode="after")
    def unknown_must_be_declared(self) -> "CategoricalMapping":
        if self.unknown not in self.values:
            raise ValueError("unknown must be included in values")
        if len(self.values) != len(set(self.values)):
            raise ValueError("categorical mapping values must be unique")
        return self


class ProcessingBundleManifest(BaseModel):
    model_config = ConfigDict(extra="allow")

    """Minimum Skill 4-compatible ProcessingBundle manifest."""

    bundle_type: Literal["ProcessingBundle"] = "ProcessingBundle"
    bundle_version: Literal["0.7"] = "0.7"
    processing_bundle_id: OpaqueBundleId
    source_bundle_id: OpaqueBundleId
    leakage_check_status: Literal["passed"] = "passed"
    leakage_check_rule_version: str = Field(min_length=1)
    processing_rule_version: str = Field(min_length=1)
    data_granularity: str = Field(min_length=1)
    feature_schema_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    file_hashes: dict[str, str] = Field(min_length=1)

    @model_validator(mode="after")
    def hashes_must_be_sha256(self) -> "ProcessingBundleManifest":
        for relative_path, digest in self.file_hashes.items():
            try:
                validate_bundle_relative_path(relative_path)
            except ValueError as exc:
                raise ValueError(
                    "file_hashes keys must be safe bundle-relative POSIX paths"
                ) from exc
            if re.fullmatch(r"[0-9a-fA-F]{64}", digest) is None:
                raise ValueError("file_hashes must map paths to SHA-256 digests")
        return self


class Skill2StartResponse(JobStartResponse):
    """Skill 2 background-job start response."""


class Skill2StatusResponse(JobStatusResponse):
    """Skill 2 background-job status response.

    ``status`` remains a string and must be able to express ``needs_input``.
    """


class Skill2ResultResponse(StrictContractModel):
    """Successful Skill 2 result with a deliberately extensible small summary."""

    processing_bundle_id: OpaqueBundleId
    summary: dict[str, Any] = Field(default_factory=dict)
