"""Local DatasetBundle artifact access by opaque bundle identity."""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from building_energy_agent.contracts.paths import validate_opaque_bundle_id
from building_energy_agent.core.artifacts import ArtifactReference
from building_energy_agent.core.artifact_store import dataset_bundles_root


class LocalDatasetBundleStore:
    """Locate completed local bundle artifacts without accepting absolute paths."""

    def __init__(self, artifact_root: str | Path) -> None:
        self.root = dataset_bundles_root(artifact_root)

    def manifest_ref(self, bundle_id: str) -> ArtifactReference:
        return self.artifact_ref(bundle_id, "manifest.json")

    def artifact_ref(
        self,
        bundle_id: str,
        relative_path: str,
    ) -> ArtifactReference:
        validate_opaque_bundle_id(bundle_id)
        relative = PurePosixPath(relative_path)
        if (
            not relative_path
            or relative.is_absolute()
            or ".." in relative.parts
            or relative_path == "."
        ):
            raise ValueError("artifact path must be bundle-relative")
        artifact = self.root / bundle_id / Path(*relative.parts)
        if not artifact.is_file():
            raise FileNotFoundError(
                f"artifact does not exist: {bundle_id}/{relative_path}"
            )
        return ArtifactReference(
            bundle_id=bundle_id,
            relative_path=relative.as_posix(),
            location_ref=str(artifact),
        )
