from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow.dataset as ds

from .errors import QualityError
from .models import DatasetBundleManifest
from .util import read_json, safe_child


POINT_COLUMNS = {
    "point_id", "name", "description", "unit", "variable_type", "expected_interval_seconds"
}
TIMESERIES_COLUMNS = {"timestamp", "point_id", "value_raw"}


@dataclass(frozen=True)
class DatasetBundle:
    root: Path
    manifest: DatasetBundleManifest
    points: pd.DataFrame
    dataset: ds.Dataset
    parse_report: dict[str, Any]

    def load_points(self, point_ids: list[str]) -> pd.DataFrame:
        if not point_ids:
            return pd.DataFrame(columns=TIMESERIES_COLUMNS)
        table = self.dataset.to_table(
            columns=sorted(TIMESERIES_COLUMNS),
            filter=ds.field("point_id").isin(point_ids),
        )
        frame = table.to_pandas()
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], utc=True, errors="coerce")
        frame["point_id"] = frame["point_id"].astype(str)
        frame["value_raw"] = pd.to_numeric(frame["value_raw"], errors="coerce")
        return frame


def load_dataset_bundle(artifact_root: Path, bundle_id: str) -> DatasetBundle:
    try:
        root = safe_child(artifact_root, "dataset-bundles", bundle_id)
    except ValueError as exc:
        raise QualityError("DATASET_BUNDLE_NOT_FOUND", "Invalid DatasetBundle ID.") from exc
    if not root.is_dir():
        raise QualityError("DATASET_BUNDLE_NOT_FOUND", "DatasetBundle does not exist.", {"source_bundle_id": bundle_id})
    try:
        manifest = DatasetBundleManifest.model_validate(read_json(root / "manifest.json"))
    except Exception as exc:
        raise QualityError("INVALID_DATASET_MANIFEST", "DatasetBundle manifest is invalid.", {"error": str(exc)}) from exc
    if manifest.dataset_bundle_id != bundle_id:
        raise QualityError("DATASET_ID_MISMATCH", "Manifest DatasetBundle ID differs from requested ID.")
    try:
        points = pd.read_parquet(root / "points.parquet")
    except Exception as exc:
        raise QualityError("INVALID_POINTS_CATALOG", "Cannot read points.parquet.", {"error": str(exc)}) from exc
    missing = sorted(POINT_COLUMNS - set(points.columns))
    if missing:
        raise QualityError("INVALID_POINTS_CATALOG", "Point catalog is missing required columns.", {"missing": missing})
    if points["point_id"].astype(str).duplicated().any():
        raise QualityError("DUPLICATE_POINT_ID", "Point catalog contains duplicate point IDs.")
    try:
        parse_report = read_json(root / "parse_report.json")
    except Exception as exc:
        raise QualityError("INVALID_PARSE_REPORT", "Cannot read parse_report.json.", {"error": str(exc)}) from exc
    if parse_report.get("dataset_bundle_id") != bundle_id:
        raise QualityError("INVALID_PARSE_REPORT", "Parse report DatasetBundle ID differs from requested ID.")
    state_encodings = parse_report.get("state_encodings", {})
    if not isinstance(state_encodings, dict):
        raise QualityError("INVALID_PARSE_REPORT", "state_encodings must be an object.")
    path = root / "data" / "timeseries"
    if not path.is_dir():
        raise QualityError("TIMESERIES_NOT_FOUND", "DatasetBundle has no timeseries directory.")
    try:
        dataset = ds.dataset(path, format="parquet", partitioning="hive")
    except Exception as exc:
        raise QualityError("INVALID_TIMESERIES", "Cannot open timeseries dataset.", {"error": str(exc)}) from exc
    missing = sorted(TIMESERIES_COLUMNS - set(dataset.schema.names))
    if missing:
        raise QualityError("INVALID_TIMESERIES", "Timeseries data is missing required columns.", {"missing": missing})
    return DatasetBundle(root, manifest, points, dataset, parse_report)
