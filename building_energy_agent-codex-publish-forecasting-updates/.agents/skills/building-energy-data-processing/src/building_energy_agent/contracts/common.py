"""Common lightweight contract types for V0.7."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class StrictContractModel(BaseModel):
    """Base for V0.7 API models.

    Unknown fields are rejected during the skeleton phase so interface mistakes
    are visible instead of being silently ignored. This defensive choice does
    not prevent a future, versioned contract from adding fields.
    """

    model_config = ConfigDict(extra="forbid")


class JobStartResponse(StrictContractModel):
    """Lightweight response returned when a background job is started."""

    job_id: str = Field(min_length=1)
    status: str = Field(min_length=1)


class JobStatusResponse(StrictContractModel):
    """Lightweight response returned when a background job is inspected."""

    status: str = Field(min_length=1)
    # V0.7 does not freeze whether progress is a ratio, percentage, stage
    # marker, or another compact representation.
    progress: Any = None
    current_stage: str | None = None
    warnings: list[str] = Field(default_factory=list)
