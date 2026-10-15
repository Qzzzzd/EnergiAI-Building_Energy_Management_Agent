"""Skill 1 public input/output contracts for V0.7."""

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import Field, field_validator, model_validator

from building_energy_agent.contracts.common import (
    JobStartResponse,
    JobStatusResponse,
    StrictContractModel,
)
from building_energy_agent.contracts.paths import OpaqueBundleId


class SourceReference(StrictContractModel):
    """Stable reference to one source file or reproducible upload snapshot."""

    source_ref: str = Field(min_length=1)


class ParseRequest(StrictContractModel):
    """Request to parse one or more files without merging or cleaning them."""

    sources: list[SourceReference] = Field(min_length=1)
    parse_hints: dict[str, Any] = Field(default_factory=dict)
    strict_mode: bool = False


class TimeseriesRecord(StrictContractModel):
    """Minimum logical schema for a normalized Skill 1 time-series row."""

    timestamp: datetime
    point_id: str = Field(min_length=1)
    value_raw: int | float | None

    @field_validator("timestamp")
    @classmethod
    def timestamp_must_be_utc(cls, value: datetime) -> datetime:
        """Require the unambiguous UTC representation consumed downstream."""

        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamp must be timezone-aware")
        if value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("timestamp must use UTC")
        return value


class DatasetBundleManifest(StrictContractModel):
    """Closed DatasetBundle manifest consumed by the V0.7 Skill 3 boundary."""

    bundle_type: Literal["DatasetBundle"] = "DatasetBundle"
    bundle_version: Literal["0.7"] = "0.7"
    dataset_bundle_id: OpaqueBundleId
    schema_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    time_start: datetime
    time_end: datetime

    @field_validator("time_start", "time_end")
    @classmethod
    def time_boundary_must_be_utc(cls, value: datetime) -> datetime:
        """Require timezone-aware UTC boundaries."""

        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("DatasetBundle time boundaries must be timezone-aware")
        if value.utcoffset() != UTC.utcoffset(value):
            raise ValueError("DatasetBundle time boundaries must use UTC")
        return value

    @model_validator(mode="after")
    def time_range_must_be_ordered(self) -> "DatasetBundleManifest":
        if self.time_start > self.time_end:
            raise ValueError("time_start must not be after time_end")
        return self


class PointCatalogEntry(StrictContractModel):
    """Required logical columns in ``points.parquet``."""

    point_id: str = Field(min_length=1)
    name: str
    description: str
    unit: str | None
    variable_type: Literal["continuous", "state", "enum"]
    expected_interval_seconds: int = Field(gt=0)


class Skill1InlineSummary(StrictContractModel):
    """Small summary returned without inlining parsed observations."""

    successful_file_count: int = Field(default=0, ge=0)
    failed_file_count: int = Field(default=0, ge=0)
    successful_worksheet_count: int = Field(default=0, ge=0)
    failed_worksheet_count: int = Field(default=0, ge=0)
    timeseries_table_count: int = Field(default=0, ge=0)
    regular_table_count: int = Field(default=0, ge=0)
    point_count: int = Field(default=0, ge=0)
    record_count: int = Field(default=0, ge=0)
    # The detailed parse report owns the eventual time-range representation.
    time_range: dict[str, Any] | None = None
    main_warnings: list[str] = Field(default_factory=list)
    needs_input: bool = False


class Skill1StartResponse(JobStartResponse):
    """Skill 1 background-job start response."""


class Skill1StatusResponse(JobStatusResponse):
    """Skill 1 background-job status response.

    ``status`` remains a string. Implementations must support the
    ``needs_input`` semantic without freezing a complete status enum.
    """


class Skill1ResultResponse(StrictContractModel):
    """Successful Skill 1 result.

    V0.7 does not yet model failure or ``needs_input`` result nullability as a
    complex union.
    """

    dataset_bundle_id: OpaqueBundleId
    summary: Skill1InlineSummary
