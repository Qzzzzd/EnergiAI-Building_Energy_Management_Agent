"""Shared local Artifact Store collection paths."""

from __future__ import annotations

from pathlib import Path


DATASET_BUNDLES_DIRECTORY = "dataset-bundles"
PROCESSING_BUNDLES_DIRECTORY = "processing-bundles"
QUALITY_ASSESSMENT_BUNDLES_DIRECTORY = "quality-assessment-bundles"
MODEL_BUNDLES_DIRECTORY = "model-bundles"
EVALUATION_BUNDLES_DIRECTORY = "evaluation-bundles"
FORECAST_BUNDLES_DIRECTORY = "forecast-bundles"


def artifact_root_path(artifact_root: str | Path) -> Path:
    """Return the normalized root shared by all pipeline stages."""

    return Path(artifact_root).expanduser().resolve()


def dataset_bundles_root(artifact_root: str | Path) -> Path:
    """Return the DatasetBundle collection below the shared root."""

    return artifact_root_path(artifact_root) / DATASET_BUNDLES_DIRECTORY


def dataset_bundle_root(artifact_root: str | Path, bundle_id: str) -> Path:
    """Return one DatasetBundle location below the shared root."""

    return dataset_bundles_root(artifact_root) / bundle_id


def processing_bundles_root(artifact_root: str | Path) -> Path:
    """Return the ProcessingBundle collection below the shared root."""

    return artifact_root_path(artifact_root) / PROCESSING_BUNDLES_DIRECTORY


def processing_bundle_root(artifact_root: str | Path, bundle_id: str) -> Path:
    """Return one ProcessingBundle location below the shared root."""

    return processing_bundles_root(artifact_root) / bundle_id
