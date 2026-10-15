"""Skill 1 service and DatasetBundle access ports."""

from typing import Protocol

from building_energy_agent.contracts.skill1_v07 import (
    ParseRequest,
    Skill1ResultResponse,
    Skill1StartResponse,
    Skill1StatusResponse,
)
from building_energy_agent.core.artifacts import BundleArtifactAccess


class Skill1Service(Protocol):
    """Asynchronous Skill 1 service boundary."""

    def start(self, request: ParseRequest) -> Skill1StartResponse:
        """Start parsing in a background job."""
        ...

    def status(self, job_id: str) -> Skill1StatusResponse:
        """Return a lightweight job status."""
        ...

    def result(self, job_id: str) -> Skill1ResultResponse:
        """Return a completed job's bundle ID and small summary."""
        ...


class DatasetBundleAccess(BundleArtifactAccess, Protocol):
    """Locate DatasetBundle manifests and artifacts by opaque bundle ID."""
