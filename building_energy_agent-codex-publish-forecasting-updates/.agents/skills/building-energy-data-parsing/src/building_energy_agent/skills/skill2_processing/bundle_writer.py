"""Serialize prepared Skill 2 rows into Skill 4-compatible V0.7 bundles."""

from __future__ import annotations

import hashlib
import json
import math
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Literal

import pyarrow as pa
import pyarrow.parquet as pq

from building_energy_agent.contracts.bundle_layouts import (
    PROCESSING_BACKTEST_BUNDLE_V07,
    PROCESSING_FUTURE_BUNDLE_V07,
)
from building_energy_agent.contracts.fingerprints import feature_schema_fingerprint
from building_energy_agent.contracts.skill2_v07 import (
    CategoricalMapping,
    FeatureCatalogEntry,
    FeatureSetRow,
    ForecastIndexRow,
    LabelSetRow,
    ProcessingBundleManifest,
    TargetMetadata,
)
from building_energy_agent.core.artifact_store import processing_bundles_root


ProcessingMode = Literal["backtest", "future"]
BACKTEST_SPLITS = ("train", "validation", "test")
FUTURE_SPLITS = ("future",)
RESERVED_MODEL_FEATURE_NAMES = {
    "sample_id",
    "feature_cutoff_timestamp",
    "forecast_start_timestamp",
    "forecast_end_timestamp",
    "target_timestamp",
    "horizon_step",
    "horizon_duration",
    "calendar_hour",
    "calendar_weekday",
    "calendar_month",
    "split",
}
META_FEATURE_COLUMNS = (
    "sample_id",
    "feature_cutoff_timestamp",
    "forecast_start_timestamp",
    "forecast_end_timestamp",
)

FEATURE_CATALOG_SCHEMA = pa.schema(
    [
        pa.field("feature_name", pa.string(), nullable=False),
        pa.field("data_type", pa.string(), nullable=False),
        pa.field("source_point_id", pa.string(), nullable=True),
        pa.field("semantic_version", pa.string(), nullable=False),
    ]
)
FORECAST_INDEX_SCHEMA = pa.schema(
    [
        pa.field("sample_id", pa.string(), nullable=False),
        pa.field("target_timestamp", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("horizon_step", pa.int64(), nullable=False),
        pa.field("horizon_duration", pa.string(), nullable=False),
        pa.field("calendar_hour", pa.int64(), nullable=False),
        pa.field("calendar_weekday", pa.int64(), nullable=False),
        pa.field("calendar_month", pa.int64(), nullable=False),
    ]
)
LABEL_SCHEMA = pa.schema(
    [
        pa.field("sample_id", pa.string(), nullable=False),
        pa.field("target_timestamp", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("target_value", pa.float64(), nullable=True),
    ]
)
PROCESSED_TARGET_SCHEMA = pa.schema(
    [
        pa.field("timestamp", pa.timestamp("us", tz="UTC"), nullable=False),
        pa.field("target_value", pa.float64(), nullable=True),
        pa.field("is_observed", pa.bool_(), nullable=False),
        pa.field("gap_class", pa.string(), nullable=False),
        pa.field("segment_id", pa.int64(), nullable=True),
    ]
)


@dataclass(frozen=True, slots=True)
class ProcessingBundleWriteRequest:
    """Prepared rows and metadata; no cleaning or feature algorithm is implied."""

    mode: ProcessingMode
    source_bundle_id: str
    feature_catalog: Sequence[FeatureCatalogEntry | Mapping[str, Any]]
    target_metadata: TargetMetadata | Mapping[str, Any]
    categorical_mappings: Mapping[
        str, CategoricalMapping | Mapping[str, Any]
    ]
    features: Mapping[
        str, Sequence[FeatureSetRow | Mapping[str, Any]]
    ]
    forecast_index: Mapping[
        str, Sequence[ForecastIndexRow | Mapping[str, Any]]
    ]
    labels: Mapping[
        str, Sequence[LabelSetRow | Mapping[str, Any]]
    ] = field(default_factory=dict)
    split_manifest: Mapping[str, Any] = field(default_factory=dict)
    processing_report: Mapping[str, Any] = field(default_factory=dict)
    processed_timeseries: Sequence[Mapping[str, Any]] = field(default_factory=tuple)
    leakage_check_rule_version: str = "leakage-v1"
    processing_rule_version: str = "processing-v0.7"
    data_granularity: str = "1min"


@dataclass(frozen=True, slots=True)
class ProcessingBundleWriteOutcome:
    processing_bundle_id: str
    bundle_path: Path
    mode: ProcessingMode
    split_sample_counts: dict[str, int]
    forecast_index_row_count: int
    label_row_count: int


@dataclass(frozen=True, slots=True)
class _ValidatedPayload:
    mode: ProcessingMode
    source_bundle_id: str
    feature_catalog: tuple[FeatureCatalogEntry, ...]
    target_metadata: TargetMetadata
    categorical_mappings: dict[str, CategoricalMapping]
    features: dict[str, tuple[FeatureSetRow, ...]]
    forecast_index: dict[str, tuple[ForecastIndexRow, ...]]
    labels: dict[str, tuple[LabelSetRow, ...]]
    split_manifest: Mapping[str, Any]
    processing_report: Mapping[str, Any]
    processed_timeseries: tuple[Mapping[str, Any], ...]
    leakage_check_rule_version: str
    processing_rule_version: str
    data_granularity: str


class LocalProcessingBundleWriter:
    """Atomically write immutable ProcessingBundles below one shared root."""

    def __init__(self, artifact_root: str | Path) -> None:
        self.root = processing_bundles_root(artifact_root)

    def write(
        self,
        request: ProcessingBundleWriteRequest,
    ) -> ProcessingBundleWriteOutcome:
        payload = _validate_request(request)
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=".processing-", dir=self.root))
        try:
            _write_payload_files(temporary, payload)
            file_hashes = _file_hashes(temporary)
            bundle_id = _processing_bundle_id(payload, file_hashes)
            manifest = ProcessingBundleManifest(
                processing_bundle_id=bundle_id,
                source_bundle_id=payload.source_bundle_id,
                leakage_check_status="passed",
                leakage_check_rule_version=payload.leakage_check_rule_version,
                processing_rule_version=payload.processing_rule_version,
                data_granularity=payload.data_granularity,
                feature_schema_fingerprint=feature_schema_fingerprint(
                    entry.model_dump() for entry in payload.feature_catalog
                ),
                file_hashes=file_hashes,
                processing_mode=payload.mode,
            )
            _write_json(
                temporary / "manifest.json",
                manifest.model_dump(mode="json"),
            )
            _layout(payload.mode).validate(temporary)

            final = self.root / bundle_id
            if final.exists():
                _validate_existing(final, manifest, payload.mode)
                shutil.rmtree(temporary)
            else:
                temporary.rename(final)
            return _outcome(final, bundle_id, payload)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise


def _validate_request(
    request: ProcessingBundleWriteRequest,
) -> _ValidatedPayload:
    if request.mode not in {"backtest", "future"}:
        raise ValueError("mode must be 'backtest' or 'future'")
    expected_splits = (
        set(BACKTEST_SPLITS) if request.mode == "backtest" else set(FUTURE_SPLITS)
    )
    if set(request.features) != expected_splits:
        raise ValueError(f"features must contain exactly {sorted(expected_splits)!r}")
    if set(request.forecast_index) != expected_splits:
        raise ValueError(
            f"forecast_index must contain exactly {sorted(expected_splits)!r}"
        )
    expected_label_splits = expected_splits if request.mode == "backtest" else set()
    if set(request.labels) != expected_label_splits:
        raise ValueError(
            f"labels must contain exactly {sorted(expected_label_splits)!r}"
        )

    catalog = tuple(
        FeatureCatalogEntry.model_validate(entry) for entry in request.feature_catalog
    )
    feature_names = [entry.feature_name for entry in catalog]
    if len(feature_names) != len(set(feature_names)):
        raise ValueError("feature catalog names must be unique")
    collisions = sorted(set(feature_names) & RESERVED_MODEL_FEATURE_NAMES)
    if collisions:
        raise ValueError(
            f"feature catalog uses reserved forecast columns: {collisions!r}"
        )

    mappings = {
        name: CategoricalMapping.model_validate(mapping)
        for name, mapping in request.categorical_mappings.items()
    }
    categorical_names = {
        entry.feature_name for entry in catalog if entry.data_type == "categorical"
    }
    if set(mappings) != categorical_names:
        raise ValueError(
            "categorical mapping keys must exactly match categorical features"
        )

    target = TargetMetadata.model_validate(request.target_metadata)
    features = {
        split: tuple(FeatureSetRow.model_validate(row) for row in rows)
        for split, rows in request.features.items()
    }
    forecast_index = {
        split: tuple(ForecastIndexRow.model_validate(row) for row in rows)
        for split, rows in request.forecast_index.items()
    }
    labels = {
        split: tuple(LabelSetRow.model_validate(row) for row in rows)
        for split, rows in request.labels.items()
    }

    for split in sorted(expected_splits):
        _validate_partition(
            split=split,
            catalog=catalog,
            mappings=mappings,
            features=features[split],
            forecast_index=forecast_index[split],
            labels=labels.get(split),
        )
    if request.mode == "backtest":
        maximum_steps = {
            split: max(row.horizon_step for row in forecast_index[split])
            for split in BACKTEST_SPLITS
        }
        if maximum_steps["train"] < max(
            maximum_steps["validation"], maximum_steps["test"]
        ):
            raise ValueError(
                "train horizon must cover validation and test horizons"
            )
        for split in ("train", "validation"):
            if not any(row.target_value is not None for row in labels[split]):
                raise ValueError(f"{split} must contain at least one non-null label")

    for field_name, value in (
        ("source_bundle_id", request.source_bundle_id),
        ("leakage_check_rule_version", request.leakage_check_rule_version),
        ("processing_rule_version", request.processing_rule_version),
        ("data_granularity", request.data_granularity),
    ):
        if not isinstance(value, str) or not value:
            raise ValueError(f"{field_name} must be a non-empty string")

    return _ValidatedPayload(
        mode=request.mode,
        source_bundle_id=request.source_bundle_id,
        feature_catalog=catalog,
        target_metadata=target,
        categorical_mappings=mappings,
        features=features,
        forecast_index=forecast_index,
        labels=labels,
        split_manifest=request.split_manifest,
        processing_report=request.processing_report,
        processed_timeseries=tuple(request.processed_timeseries),
        leakage_check_rule_version=request.leakage_check_rule_version,
        processing_rule_version=request.processing_rule_version,
        data_granularity=request.data_granularity,
    )


def _validate_partition(
    *,
    split: str,
    catalog: Sequence[FeatureCatalogEntry],
    mappings: Mapping[str, CategoricalMapping],
    features: Sequence[FeatureSetRow],
    forecast_index: Sequence[ForecastIndexRow],
    labels: Sequence[LabelSetRow] | None,
) -> None:
    if not features:
        raise ValueError(f"features/{split} must not be empty")
    feature_by_id = {row.sample_id: row for row in features}
    if len(feature_by_id) != len(features):
        raise ValueError(f"features/{split} sample_id values must be unique")

    expected_features = {entry.feature_name for entry in catalog}
    catalog_by_name = {entry.feature_name: entry for entry in catalog}
    for row in features:
        actual_features = set(row.model_extra or {})
        if actual_features != expected_features:
            raise ValueError(
                f"features/{split} columns must exactly match feature_catalog"
            )
        for name, value in (row.model_extra or {}).items():
            entry = catalog_by_name[name]
            if (
                entry.data_type == "numeric"
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isinf(float(value))
            ):
                raise ValueError(f"feature {name!r} must not contain infinity")
            if entry.data_type == "categorical" and value is not None:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise ValueError(
                        f"categorical feature {name!r} must use integer codes"
                    )
                if value not in mappings[name].values:
                    raise ValueError(
                        f"categorical feature {name!r} contains an unknown code"
                    )

    if not forecast_index:
        raise ValueError(f"forecast_index/{split} must not be empty")
    index_keys = {
        (row.sample_id, row.target_timestamp) for row in forecast_index
    }
    if len(index_keys) != len(forecast_index):
        raise ValueError(
            f"forecast_index/{split} keys must be unique"
        )
    if not {row.sample_id for row in forecast_index}.issubset(feature_by_id):
        raise ValueError(
            f"forecast_index/{split} refers to unknown feature samples"
        )

    index_by_sample: dict[str, list[ForecastIndexRow]] = {}
    for row in forecast_index:
        index_by_sample.setdefault(row.sample_id, []).append(row)
    for sample_id, rows in index_by_sample.items():
        ordered = sorted(rows, key=lambda row: row.target_timestamp)
        steps = [row.horizon_step for row in ordered]
        if steps != list(range(1, len(ordered) + 1)):
            raise ValueError(
                f"forecast_index/{split} horizon steps must start at 1 "
                "and be contiguous"
            )
        feature = feature_by_id[sample_id]
        if (
            ordered[0].target_timestamp != feature.forecast_start_timestamp
            or ordered[-1].target_timestamp != feature.forecast_end_timestamp
        ):
            raise ValueError(
                f"forecast_index/{split} must cover each sample boundary"
            )
        for row in ordered:
            duration_minutes = int(
                (
                    row.target_timestamp - feature.forecast_start_timestamp
                ).total_seconds()
                // 60
            )
            if row.horizon_duration != f"{duration_minutes}min":
                raise ValueError(
                    f"forecast_index/{split} horizon_duration is inconsistent"
                )

    if labels is not None:
        label_keys = {(row.sample_id, row.target_timestamp) for row in labels}
        if len(label_keys) != len(labels):
            raise ValueError(f"labels/{split} keys must be unique")
        if label_keys != index_keys:
            raise ValueError(
                f"labels/{split} must preserve every forecast-index key"
            )


def _write_payload_files(root: Path, payload: _ValidatedPayload) -> None:
    (root / "data" / "processed_timeseries").mkdir(parents=True)
    if payload.processed_timeseries:
        _write_parquet(
            root / "data" / "processed_timeseries" / "target.parquet",
            pa.Table.from_pylist(
                list(payload.processed_timeseries),
                schema=PROCESSED_TARGET_SCHEMA,
            ),
        )
    catalog_rows = [entry.model_dump() for entry in payload.feature_catalog]
    _write_parquet(
        root / "feature_catalog.parquet",
        pa.Table.from_pylist(catalog_rows, schema=FEATURE_CATALOG_SCHEMA),
    )
    _write_json(
        root / "target_metadata.json",
        payload.target_metadata.model_dump(mode="json"),
    )
    _write_json(
        root / "categorical_mappings.json",
        {
            name: mapping.model_dump(mode="json")
            for name, mapping in sorted(payload.categorical_mappings.items())
        },
    )
    _write_json(root / "split_manifest.json", payload.split_manifest)
    _write_json(root / "processing_report.json", payload.processing_report)

    feature_schema = _feature_schema(payload.feature_catalog)
    for split, rows in payload.features.items():
        feature_rows = []
        for row in rows:
            dumped = row.model_dump(mode="python")
            feature_rows.append(
                {
                    **{name: dumped[name] for name in META_FEATURE_COLUMNS},
                    **{
                        entry.feature_name: dumped[entry.feature_name]
                        for entry in payload.feature_catalog
                    },
                }
            )
        _write_parquet(
            root / "features" / f"split={split}" / "data.parquet",
            pa.Table.from_pylist(feature_rows, schema=feature_schema),
        )

    for split, rows in payload.forecast_index.items():
        _write_parquet(
            root / "forecast_index" / f"split={split}" / "data.parquet",
            pa.Table.from_pylist(
                [row.model_dump(mode="python") for row in rows],
                schema=FORECAST_INDEX_SCHEMA,
            ),
        )

    for split, rows in payload.labels.items():
        _write_parquet(
            root / "labels" / f"split={split}" / "data.parquet",
            pa.Table.from_pylist(
                [row.model_dump(mode="python") for row in rows],
                schema=LABEL_SCHEMA,
            ),
        )


def _feature_schema(
    catalog: Sequence[FeatureCatalogEntry],
) -> pa.Schema:
    fields = [
        pa.field("sample_id", pa.string(), nullable=False),
        pa.field(
            "feature_cutoff_timestamp",
            pa.timestamp("us", tz="UTC"),
            nullable=False,
        ),
        pa.field(
            "forecast_start_timestamp",
            pa.timestamp("us", tz="UTC"),
            nullable=False,
        ),
        pa.field(
            "forecast_end_timestamp",
            pa.timestamp("us", tz="UTC"),
            nullable=False,
        ),
    ]
    arrow_types = {
        "numeric": pa.float64(),
        "boolean": pa.bool_(),
        "categorical": pa.int64(),
    }
    fields.extend(
        pa.field(entry.feature_name, arrow_types[entry.data_type], nullable=True)
        for entry in catalog
    )
    return pa.schema(fields)


def _write_parquet(path: Path, table: pa.Table) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, path, compression="zstd")


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
            default=_json_default,
        )
        + "\n",
        encoding="utf-8",
    )


def _json_default(value: object) -> str:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _file_hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): _sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != "manifest.json"
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _processing_bundle_id(
    payload: _ValidatedPayload,
    file_hashes: Mapping[str, str],
) -> str:
    identity = {
        "mode": payload.mode,
        "source_bundle_id": payload.source_bundle_id,
        "leakage_check_rule_version": payload.leakage_check_rule_version,
        "processing_rule_version": payload.processing_rule_version,
        "data_granularity": payload.data_granularity,
        "file_hashes": file_hashes,
    }
    encoded = json.dumps(
        identity,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"processing-{hashlib.sha256(encoded).hexdigest()[:24]}"


def _layout(mode: ProcessingMode):
    return (
        PROCESSING_BACKTEST_BUNDLE_V07
        if mode == "backtest"
        else PROCESSING_FUTURE_BUNDLE_V07
    )


def _validate_existing(
    root: Path,
    expected: ProcessingBundleManifest,
    mode: ProcessingMode,
) -> None:
    _layout(mode).validate(root)
    actual = ProcessingBundleManifest.model_validate_json(
        (root / "manifest.json").read_text(encoding="utf-8")
    )
    if actual != expected:
        raise ValueError("existing ProcessingBundle manifest is inconsistent")
    for relative_path, expected_digest in actual.file_hashes.items():
        path = root.joinpath(*relative_path.split("/"))
        if not path.is_file() or _sha256_file(path) != expected_digest:
            raise ValueError("existing ProcessingBundle file hash is inconsistent")


def _outcome(
    root: Path,
    bundle_id: str,
    payload: _ValidatedPayload,
) -> ProcessingBundleWriteOutcome:
    return ProcessingBundleWriteOutcome(
        processing_bundle_id=bundle_id,
        bundle_path=root,
        mode=payload.mode,
        split_sample_counts={
            split: len(rows) for split, rows in payload.features.items()
        },
        forecast_index_row_count=sum(
            len(rows) for rows in payload.forecast_index.values()
        ),
        label_row_count=sum(len(rows) for rows in payload.labels.values()),
    )
