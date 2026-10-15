"""Skill 2 service and ProcessingBundle access ports."""

from typing import Protocol

from building_energy_agent.contracts.skill2_v07 import (
    ProcessingSpec,
    Skill2ResultResponse,
    Skill2StartResponse,
    Skill2StatusResponse,
)
from building_energy_agent.core.artifacts import BundleArtifactAccess


class Skill2Service(Protocol):
    """Asynchronous Skill 2 service boundary."""

    def start(self, request: ProcessingSpec) -> Skill2StartResponse:
        """Start processing in a background job."""
        ...

    def status(self, job_id: str) -> Skill2StatusResponse:
        """Return a lightweight job status."""
        ...

    def result(self, job_id: str) -> Skill2ResultResponse:
        """Return a completed job's bundle ID and small summary."""
        ...


class ProcessingBundleAccess(BundleArtifactAccess, Protocol):
    """Locate ProcessingBundle manifests and artifacts by opaque bundle ID."""
