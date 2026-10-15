from pathlib import Path

import pytest

from building_energy_agent.core.artifact_store import (
    DATASET_BUNDLES_DIRECTORY,
    PROCESSING_BUNDLES_DIRECTORY,
    dataset_bundle_root,
    dataset_bundles_root,
    processing_bundle_root,
    processing_bundles_root,
)
from building_energy_agent.skills.skill1_parse.artifacts import (
    LocalDatasetBundleStore,
)
from building_energy_agent.skills.skill2_processing.artifacts import (
    LocalProcessingBundleStore,
)


def test_dataset_bundle_uses_shared_artifact_root(tmp_path: Path) -> None:
    assert dataset_bundles_root(tmp_path) == (
        tmp_path.resolve() / DATASET_BUNDLES_DIRECTORY
    )
    assert dataset_bundle_root(tmp_path, "dataset-1") == (
        tmp_path.resolve() / DATASET_BUNDLES_DIRECTORY / "dataset-1"
    )


def test_processing_bundle_uses_shared_artifact_root(tmp_path: Path) -> None:
    assert processing_bundles_root(tmp_path) == (
        tmp_path.resolve() / PROCESSING_BUNDLES_DIRECTORY
    )
    assert processing_bundle_root(tmp_path, "processing-1") == (
        tmp_path.resolve() / PROCESSING_BUNDLES_DIRECTORY / "processing-1"
    )


@pytest.mark.parametrize("bundle_id", ["", ".", "..", "../outside", "a/b", r"a\b"])
def test_local_bundle_stores_reject_path_like_ids(
    tmp_path: Path,
    bundle_id: str,
) -> None:
    for store in (
        LocalDatasetBundleStore(tmp_path),
        LocalProcessingBundleStore(tmp_path),
    ):
        with pytest.raises(ValueError, match="opaque"):
            store.manifest_ref(bundle_id)
