from __future__ import annotations

import json
import math
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .errors import ForecastError
from .util import canonical_json, content_id, read_json, safe_child, sha256_bytes, sha256_file

SPLITS = ("train", "validation", "test")
SUPPORTED_TYPES = {"numeric", "boolean", "categorical"}
META_FEATURE_COLUMNS = {
    "sample_id",
    "feature_cutoff_timestamp",
    "forecast_start_timestamp",
    "forecast_end_timestamp",
}
INDEX_KEY_COLUMNS = {"sample_id", "target_timestamp", "horizon_step", "horizon_duration"}
INDEX_BASE_COLUMNS = INDEX_KEY_COLUMNS | {
    "calendar_hour",
    "calendar_weekday",
    "calendar_month",
    "split",
}


@dataclass(frozen=True)
class ProcessingBundle:
    root: Path
    manifest: dict[str, Any]
    catalog: pd.DataFrame
    target: dict[str, Any]
    split_manifest: dict[str, Any]
    categorical_mappings: dict[str, Any]

    @property
    def bundle_id(self) -> str:
        return str(self.manifest["processing_bundle_id"])

    @property
    def feature_names(self) -> list[str]:
        return self.catalog["feature_name"].astype(str).tolist()

    @property
    def feature_types(self) -> dict[str, str]:
        return dict(zip(self.catalog["feature_name"], self.catalog["data_type"], strict=True))

    @property
    def fingerprint(self) -> str:
        return str(self.manifest["feature_schema_fingerprint"])

    def load_split(self, kind: str, split: str) -> pd.DataFrame:
        return pd.read_parquet(self.root / kind / f"split={split}" / "data.parquet")


def schema_payload(catalog: pd.DataFrame) -> list[dict[str, str]]:
    fields = ["feature_name", "data_type", "source_point_id", "semantic_version"]
    return [
        {field: "" if pd.isna(row[field]) else str(row[field]) for field in fields}
        for _, row in catalog[fields].iterrows()
    ]


def schema_fingerprint(
    catalog: pd.DataFrame,
    index_feature_names: Iterable[str] = (),
) -> str:
    payload = schema_payload(catalog)
    payload.extend(
        {
            "feature_name": str(name),
            "data_type": "numeric",
            "source_point_id": "forecast_index",
            "semantic_version": "known-future-v1",
        }
        for name in sorted(set(index_feature_names))
    )
    return sha256_bytes(canonical_json(payload).encode())


def resolve_processing_bundle(artifact_root: Path, bundle_id: str) -> Path:
    if not bundle_id or "/" in bundle_id or "\\" in bundle_id or bundle_id in {".", ".."}:
        raise ForecastError("PROCESSING_BUNDLE_NOT_FOUND", "Invalid processing bundle ID.")
    path = safe_child(artifact_root, "processing-bundles", bundle_id)
    if not path.is_dir():
        raise ForecastError("PROCESSING_BUNDLE_NOT_FOUND", "Processing bundle does not exist.", {"processing_bundle_id": bundle_id})
    return path


def _require_columns(frame: pd.DataFrame, required: Iterable[str], code: str, source: str) -> None:
    missing = sorted(set(required) - set(frame.columns))
    if missing:
        raise ForecastError(code, f"{source} is missing required columns.", {"missing_columns": missing})


def _verify_hashes(root: Path, manifest: dict[str, Any]) -> None:
    hashes = manifest.get("file_hashes")
    if not isinstance(hashes, dict) or not hashes:
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Processing bundle file hashes are missing.")
    for relative, expected in hashes.items():
        try:
            path = safe_child(root, relative)
        except ValueError as exc:
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", str(exc)) from exc
        if not path.is_file() or sha256_file(path) != expected:
            raise ForecastError(
                "INCOMPATIBLE_PROCESSING_BUNDLE",
                "Processing bundle file is missing or has a hash mismatch.",
                {"path": relative},
            )


def load_processing_bundle(artifact_root: Path, bundle_id: str, mode: str) -> ProcessingBundle:
    root = resolve_processing_bundle(artifact_root, bundle_id)
    required_files = [
        "manifest.json",
        "feature_catalog.parquet",
        "target_metadata.json",
        "split_manifest.json",
        "categorical_mappings.json",
    ]
    if any(not (root / name).is_file() for name in required_files):
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Required ProcessingBundle metadata is missing.")
    manifest = read_json(root / "manifest.json")
    if manifest.get("bundle_type") != "ProcessingBundle" or str(manifest.get("bundle_version")) != "0.7":
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Unsupported ProcessingBundle type or version.")
    if manifest.get("processing_bundle_id") != bundle_id:
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Bundle ID does not match its manifest.")
    declared_mode = manifest.get("processing_mode")
    if declared_mode is not None and declared_mode != mode:
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "ProcessingBundle mode does not match the requested mode.")
    if manifest.get("leakage_check_status") != "passed":
        raise ForecastError("LEAKAGE_CHECK_NOT_PASSED", "Skill 2 leakage check did not explicitly pass.")
    if not manifest.get("leakage_check_rule_version"):
        raise ForecastError("LEAKAGE_CHECK_NOT_PASSED", "Leakage check rule version is missing.")
    _verify_hashes(root, manifest)

    catalog = pd.read_parquet(root / "feature_catalog.parquet")
    _require_columns(
        catalog,
        ["feature_name", "data_type", "source_point_id", "semantic_version"],
        "INCOMPATIBLE_PROCESSING_BUNDLE",
        "feature_catalog",
    )
    if catalog["feature_name"].duplicated().any() or not set(catalog["data_type"]).issubset(SUPPORTED_TYPES):
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Feature catalog names or data types are invalid.")
    target = read_json(root / "target_metadata.json")
    if not {"target_point_id", "target_name", "target_unit"}.issubset(target):
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Target metadata is incomplete.")
    mappings = read_json(root / "categorical_mappings.json")
    categorical = catalog.loc[catalog["data_type"] == "categorical", "feature_name"].tolist()
    if set(mappings) != set(categorical):
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Categorical mappings do not match the feature catalog.")
    for name in categorical:
        mapping = mappings[name]
        try:
            unknown = int(mapping["unknown"])
            values = {int(value) for value in mapping["values"]}
        except (KeyError, TypeError, ValueError) as exc:
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Categorical mapping is malformed.", {"feature": name}) from exc
        if unknown not in values:
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Categorical mapping does not reserve its unknown value.", {"feature": name})

    splits = SPLITS if mode == "backtest" else ("future",)
    for split in splits:
        feature_path = root / "features" / f"split={split}" / "data.parquet"
        index_path = root / "forecast_index" / f"split={split}" / "data.parquet"
        if not feature_path.is_file():
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Feature partition is missing.", {"split": split})
        if not index_path.is_file():
            raise ForecastError("FORECAST_INDEX_MISSING", "Forecast-index partition is missing.", {"split": split})
        if mode == "backtest" and not (root / "labels" / f"split={split}" / "data.parquet").is_file():
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Label partition is missing.", {"split": split})
    index_feature_names = {
        name
        for split in splits
        for name in pd.read_parquet(root / "forecast_index" / f"split={split}" / "data.parquet").columns
        if name not in INDEX_BASE_COLUMNS
    }
    fingerprint = schema_fingerprint(catalog, index_feature_names)
    if manifest.get("feature_schema_fingerprint") != fingerprint:
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Feature schema fingerprint is invalid.")

    return ProcessingBundle(
        root=root,
        manifest=manifest,
        catalog=catalog,
        target=target,
        split_manifest=read_json(root / "split_manifest.json"),
        categorical_mappings=mappings,
    )


def validate_and_expand(bundle: ProcessingBundle, split: str, with_labels: bool) -> tuple[pd.DataFrame, list[str], list[str]]:
    features = bundle.load_split("features", split)
    index = bundle.load_split("forecast_index", split)
    _require_columns(features, META_FEATURE_COLUMNS | set(bundle.feature_names), "INCOMPATIBLE_PROCESSING_BUNDLE", f"features/{split}")
    _require_columns(index, INDEX_KEY_COLUMNS, "FORECAST_INDEX_INCOMPLETE", f"forecast_index/{split}")
    if features["sample_id"].duplicated().any():
        raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Feature sample_id must be unique.", {"split": split})
    if index.duplicated(["sample_id", "target_timestamp"]).any():
        raise ForecastError("FORECAST_INDEX_INCOMPLETE", "Forecast-index keys must be unique.", {"split": split})
    if index.empty or not set(index["sample_id"]).issubset(set(features["sample_id"])):
        raise ForecastError("FORECAST_INDEX_INCOMPLETE", "Forecast index is empty or refers to unknown samples.", {"split": split})
    feature_columns = set(features.columns) - META_FEATURE_COLUMNS
    index_feature_columns = set(index.columns) - INDEX_KEY_COLUMNS - {"split"}
    collisions = sorted(feature_columns & index_feature_columns)
    if collisions:
        raise ForecastError(
            "FEATURE_NAME_COLLISION",
            "FeatureSet and forecast-index feature names overlap.",
            {"split": split, "columns": collisions},
        )

    index = index.copy()
    index["target_timestamp"] = pd.to_datetime(index["target_timestamp"])
    for _, group in index.groupby("sample_id", sort=False):
        ordered = group.sort_values("target_timestamp")
        steps = ordered["horizon_step"].to_numpy(dtype=int)
        if not np.array_equal(steps, np.arange(1, len(steps) + 1)):
            raise ForecastError("FORECAST_INDEX_INCOMPLETE", "horizon_step must be contiguous from 1 and increase with target time.", {"split": split})

    profile_columns = sorted(
        (
            name
            for name in bundle.feature_names
            if re.fullmatch(r".+_profile_lag_\d+min_step_\d+", name)
        ),
        key=_profile_sort_key,
    )
    profile_groups: dict[str, list[str]] = {}
    for name in profile_columns:
        match = re.fullmatch(r"(?P<prefix>.+)_profile_lag_(?P<minutes>\d+)min_step_(?P<step>\d+)", name)
        if match is None:
            raise ForecastError(
                "INCOMPATIBLE_PROCESSING_BUNDLE",
                "Previous-day profile feature name is invalid.",
                {"feature": name},
            )
        prefix = match.group("prefix")
        profile_groups.setdefault(prefix, []).append(name)
    for prefix, names in profile_groups.items():
        expected_steps = list(range(1, len(names) + 1))
        observed_steps = [_profile_step(name) for name in names]
        if observed_steps != expected_steps:
            raise ForecastError(
                "FORECAST_INDEX_INCOMPLETE",
                "Previous-day profile steps must be contiguous from 1.",
                {"profile": prefix},
            )
    merge_features = features.drop(columns=profile_columns, errors="ignore")
    expanded = index.merge(
        merge_features,
        on="sample_id",
        how="left",
        validate="many_to_one",
        sort=False,
    )
    if profile_groups:
        profile_index = pd.Index(features["sample_id"].astype(str))
        sample_positions = profile_index.get_indexer(expanded["sample_id"].astype(str))
        horizon_positions = expanded["horizon_step"].to_numpy(dtype=int) - 1
        if (sample_positions < 0).any() or (horizon_positions < 0).any():
            raise ForecastError(
                "FORECAST_INDEX_INCOMPLETE",
                "Previous-day profile does not cover every forecast sample.",
                {"split": split},
            )
        for prefix, names in profile_groups.items():
            if (horizon_positions >= len(names)).any():
                raise ForecastError(
                    "FORECAST_INDEX_INCOMPLETE",
                    "Previous-day profile does not cover every forecast step.",
                    {"split": split, "profile": prefix},
                )
            profile_matrix = features.loc[:, names].to_numpy(dtype=float)
            expanded_name = (
                "target_prev_day_same_time"
                if prefix == "target"
                else f"{prefix}_prev_day_same_time"
            )
            expanded[expanded_name] = profile_matrix[
                sample_positions, horizon_positions
            ]
            if prefix == "target":
                previous = expanded[expanded_name].to_numpy(dtype=float)
                latest = _latest_target_lag(expanded)
                denominator = np.where(np.abs(previous) > 1e-8, previous, np.nan)
                expanded["target_level_delta_prev_day"] = latest - previous
                expanded["target_level_ratio_prev_day"] = latest / denominator
    for _, group in expanded.groupby("sample_id", sort=False):
        start = pd.Timestamp(group["forecast_start_timestamp"].iloc[0])
        end = pd.Timestamp(group["forecast_end_timestamp"].iloc[0])
        targets = pd.to_datetime(group["target_timestamp"])
        if targets.min() != start or targets.max() != end:
            raise ForecastError("FORECAST_INDEX_INCOMPLETE", "Forecast index does not cover the sample start and end.", {"split": split})
    profile_expanded_names = [
        "target_prev_day_same_time" if prefix == "target" else f"{prefix}_prev_day_same_time"
        for prefix in profile_groups
    ]
    target_level_features = (
        ["target_level_delta_prev_day", "target_level_ratio_prev_day"]
        if "target_prev_day_same_time" in profile_expanded_names
        else []
    )
    model_features = [
        name for name in bundle.feature_names if name not in profile_columns
    ] + profile_expanded_names + target_level_features + [
        column for column in index.columns if column not in INDEX_KEY_COLUMNS and column != "split"
    ]
    model_features += ["horizon_step"]
    model_features = list(dict.fromkeys(model_features))
    categorical = [name for name in bundle.feature_names if bundle.feature_types[name] == "categorical"]
    for name in model_features:
        if name in categorical:
            allowed = {int(key) for key in bundle.categorical_mappings[name]["values"]}
            observed = set(expanded[name].dropna().astype(int))
            if not observed.issubset(allowed):
                raise ForecastError("CATEGORY_MAPPING_MISMATCH", "Categorical value is not in the frozen mapping.", {"feature": name})
            expanded[name] = pd.Categorical(expanded[name].astype("Int64"), categories=sorted(allowed))
        else:
            try:
                expanded[name] = pd.to_numeric(expanded[name])
            except (TypeError, ValueError) as exc:
                raise ForecastError("INVALID_FEATURE_VALUE", "Feature has an illegal data type.", {"feature": name}) from exc
            values = expanded[name].to_numpy(dtype=float, na_value=np.nan)
            if np.isinf(values).any():
                raise ForecastError("INVALID_FEATURE_VALUE", "Feature contains an infinite value.", {"feature": name})

    if with_labels:
        labels = bundle.load_split("labels", split)
        _require_columns(labels, ["sample_id", "target_timestamp", "target_value"], "INCOMPATIBLE_PROCESSING_BUNDLE", f"labels/{split}")
        labels = labels.copy()
        labels["target_timestamp"] = pd.to_datetime(labels["target_timestamp"])
        if labels.duplicated(["sample_id", "target_timestamp"]).any():
            raise ForecastError("INCOMPATIBLE_PROCESSING_BUNDLE", "Label keys must be unique.", {"split": split})
        expanded = expanded.merge(labels, on=["sample_id", "target_timestamp"], how="left", validate="one_to_one")
    return expanded.sort_values(["sample_id", "target_timestamp"]).reset_index(drop=True), model_features, categorical


def estimate_resources(bundle: ProcessingBundle, splits: Iterable[str], memory_limit: int, disk_limit: int) -> dict[str, Any]:
    rows = 0
    for split in splits:
        rows += len(bundle.load_split("forecast_index", split))
    profile_count = sum(
        bool(re.fullmatch(r".+_profile_lag_\d+min_step_\d+", name))
        for name in bundle.feature_names
    )
    profile_groups = {
        re.fullmatch(r"(?P<prefix>.+)_profile_lag_\d+min_step_\d+", name).group("prefix")
        for name in bundle.feature_names
        if re.fullmatch(r".+_profile_lag_\d+min_step_\d+", name)
    }
    columns = (
        len(bundle.feature_names)
        - profile_count
        + len(profile_groups)
        + 8
    )
    matrix_bytes = int(rows * columns * 8 * 2.5)
    disk_bytes = int(matrix_bytes * 2)
    estimate = {
        "expanded_rows": rows,
        "estimated_columns": columns,
        "estimated_memory_bytes": matrix_bytes,
        "estimated_temporary_disk_bytes": disk_bytes,
        "memory_budget_bytes": memory_limit,
        "disk_budget_bytes": disk_limit,
    }
    if matrix_bytes > memory_limit or disk_bytes > disk_limit:
        raise ForecastError("RESOURCE_BUDGET_EXCEEDED", "Estimated matrix exceeds the configured resource budget.", estimate)
    return estimate


def _profile_sort_key(name: str) -> tuple[str, int, int]:
    match = re.fullmatch(r"(?P<prefix>.+)_profile_lag_(?P<minutes>\d+)min_step_(?P<step>\d+)", name)
    if match is None:
        return (name, 0, 0)
    return (match.group("prefix"), int(match.group("minutes")), int(match.group("step")))


def _profile_step(name: str) -> int:
    match = re.fullmatch(r".+_profile_lag_\d+min_step_(?P<step>\d+)", name)
    if match is None:
        raise ForecastError(
            "INCOMPATIBLE_PROCESSING_BUNDLE",
            "Previous-day profile feature name is invalid.",
            {"feature": name},
        )
    return int(match.group("step"))


def _latest_target_lag(frame: pd.DataFrame) -> np.ndarray:
    lag_columns = []
    for name in frame.columns:
        match = re.fullmatch(r"target_lag_(\d+)min", str(name))
        if match is not None:
            lag_columns.append((int(match.group(1)), name))
    if not lag_columns:
        return np.full(len(frame), np.nan, dtype=float)
    _, column = min(lag_columns)
    return pd.to_numeric(frame[column], errors="coerce").to_numpy(dtype=float)


class AtomicBundleWriter:
    def __init__(self, parent: Path, bundle_id: str):
        self.parent = parent
        self.bundle_id = bundle_id
        self.temp: Path | None = None

    def __enter__(self) -> Path:
        self.parent.mkdir(parents=True, exist_ok=True)
        if (self.parent / self.bundle_id).exists():
            raise ForecastError("MODEL_ARTIFACT_INVALID", "Immutable bundle ID already exists.", {"bundle_id": self.bundle_id})
        self.temp = Path(tempfile.mkdtemp(prefix=f".{self.bundle_id}.", dir=self.parent))
        return self.temp

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        assert self.temp is not None
        if exc_type is None:
            self.temp.rename(self.parent / self.bundle_id)
        else:
            shutil.rmtree(self.temp, ignore_errors=True)


def write_manifest(root: Path, payload: dict[str, Any]) -> None:
    hashes = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name != "manifest.json":
            hashes[path.relative_to(root).as_posix()] = sha256_file(path)
    payload = {**payload, "file_hashes": hashes}
    (root / "manifest.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
