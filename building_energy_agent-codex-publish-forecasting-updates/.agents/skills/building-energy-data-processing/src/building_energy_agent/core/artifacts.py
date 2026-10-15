"""Ports for locating bundle manifests and artifacts."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class ArtifactReference:
    """An opaque storage reference for one bundle-relative artifact."""

    bundle_id: str
    relative_path: str
    location_ref: str


class BundleArtifactAccess(Protocol):
    """Locate bundle artifacts without prescribing a storage implementation."""

    def manifest_ref(self, bundle_id: str) -> ArtifactReference:
        """Locate a bundle's manifest by opaque bundle ID."""
        ...

    def artifact_ref(
        self,
        bundle_id: str,
        relative_path: str,
    ) -> ArtifactReference:
        """Locate one manifest-declared artifact by bundle-relative path."""
        ...
