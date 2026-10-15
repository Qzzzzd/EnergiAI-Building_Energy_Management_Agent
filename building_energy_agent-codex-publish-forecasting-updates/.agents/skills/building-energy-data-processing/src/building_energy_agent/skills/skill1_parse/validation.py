"""Streaming validation for a concrete V0.7 DatasetBundle."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from building_energy_agent.contracts.bundle_layouts import DATASET_BUNDLE_V07
from building_energy_agent.contracts.fingerprints import dataset_schema_fingerprint
from building_energy_agent.contracts.skill1_v07 import (
    DatasetBundleManifest,
    PointCatalogEntry,
)
from building_energy_agent.core.errors import SkillParseError
from building_energy_agent.skills.skill1_parse.sources import sha256_file


def validate_dataset_bundle(bundle_path: str | Path) -> dict[str, Any]:
    """Validate identity, schemas, hashes, time bounds, and readable Parquet."""

    root = Path(bundle_path).expanduser().resolve(strict=True)
    DATASET_BUNDLE_V07.validate(root)
    manifest_payload = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    expected_manifest_fields = {
        "bundle_type",
        "bundle_version",
        "dataset_bundle_id",
        "schema_fingerprint",
        "time_start",
        "time_end",
    }
    if set(manifest_payload) != expected_manifest_fields:
        raise SkillParseError("DatasetBundle manifest fields are not strictly closed")
    manifest = DatasetBundleManifest.model_validate(manifest_payload)
    if root.name != manifest.dataset_bundle_id:
        raise SkillParseError("bundle directory name does not equal dataset_bundle_id")

    points_table = pq.read_table(root / "points.parquet")
    required_point_columns = {
        "point_id",
        "name",
        "description",
        "unit",
        "variable_type",
        "expected_interval_seconds",
    }
    if not required_point_columns.issubset(points_table.column_names):
        raise SkillParseError("points.parquet is missing required columns")
    points = points_table.select(sorted(required_point_columns)).to_pylist()
    normalized_points: list[dict[str, Any]] = []
    point_ids: set[str] = set()
    for point in points:
        validated = PointCatalogEntry.model_validate(point)
        if validated.point_id in point_ids:
            raise SkillParseError("points.parquet contains duplicate point_id values")
        point_ids.add(validated.point_id)
        normalized_points.append(validated.model_dump())
    if dataset_schema_fingerprint(normalized_points) != manifest.schema_fingerprint:
        raise SkillParseError("schema_fingerprint does not match points.parquet")

    parquet_files = sorted((root / "data" / "timeseries").rglob("*.parquet"))
    if not parquet_files:
        raise SkillParseError("DatasetBundle contains no time-series Parquet files")
    total_records = 0
    total_nulls = 0
    observed_start: datetime | None = None
    observed_end: datetime | None = None
    for parquet_path in parquet_files:
        parquet_file = pq.ParquetFile(parquet_path)
        schema = parquet_file.schema_arrow
        if not {"timestamp", "point_id", "value_raw"}.issubset(schema.names):
            raise SkillParseError(f"time-series schema is incomplete: {parquet_path.name}")
        timestamp_type = schema.field("timestamp").type
        value_type = schema.field("value_raw").type
        if not pa.types.is_timestamp(timestamp_type) or timestamp_type.tz not in {
            "UTC",
            "+00:00",
        }:
            raise SkillParseError("time-series timestamps must be timezone-aware UTC")
        if not (
            pa.types.is_integer(value_type)
            or pa.types.is_floating(value_type)
            or pa.types.is_decimal(value_type)
        ):
            raise SkillParseError("value_raw must use a numeric Arrow type")
        for batch in parquet_file.iter_batches(
            columns=["timestamp", "point_id", "value_raw"], batch_size=65_536
        ):
            total_records += batch.num_rows
            total_nulls += batch.column("value_raw").null_count
            unknown_points = {
                value.as_py() for value in pc.unique(batch.column("point_id"))
            } - point_ids
            if unknown_points:
                raise SkillParseError(
                    f"time-series rows reference unknown point IDs: {unknown_points!r}"
                )
            bounds = pc.min_max(batch.column("timestamp")).as_py()
            batch_start = bounds["min"]
            batch_end = bounds["max"]
            observed_start = (
                batch_start
                if observed_start is None
                else min(observed_start, batch_start)
            )
            observed_end = (
                batch_end if observed_end is None else max(observed_end, batch_end)
            )
    if observed_start != manifest.time_start or observed_end != manifest.time_end:
        raise SkillParseError("manifest time range does not match time-series data")

    report = json.loads((root / "parse_report.json").read_text(encoding="utf-8"))
    if report.get("dataset_bundle_id") != manifest.dataset_bundle_id:
        raise SkillParseError("parse report identity does not match manifest")
    state_encodings = report.get("state_encodings", {})
    if not isinstance(state_encodings, dict):
        raise SkillParseError("parse report state_encodings must be an object")
    point_by_id = {point["point_id"]: point for point in normalized_points}
    for point_id, mapping in state_encodings.items():
        point = point_by_id.get(point_id)
        if point is None or point["variable_type"] not in {"state", "enum"}:
            raise SkillParseError(
                "state_encodings must reference a known state or enum point"
            )
        if not isinstance(mapping, dict) or not mapping:
            raise SkillParseError("each state_encodings entry must be non-empty")
        if any(
            not isinstance(label, str)
            or not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            for label, value in mapping.items()
        ):
            raise SkillParseError(
                "state_encodings must map text labels to finite numeric values"
            )
    for relative_path, expected_hash in report.get("output_file_hashes", {}).items():
        output_path = root / relative_path
        if not output_path.is_file():
            raise SkillParseError(f"declared output file is missing: {relative_path}")
        if sha256_file(output_path) != expected_hash:
            raise SkillParseError(f"declared output hash mismatch: {relative_path}")
    if report.get("record_count") != total_records:
        raise SkillParseError("parse report record_count does not match Parquet")
    if report.get("null_count") != total_nulls:
        raise SkillParseError("parse report null_count does not match Parquet")

    return {
        "dataset_bundle_id": manifest.dataset_bundle_id,
        "bundle_path": str(root),
        "worksheet_count": report.get("worksheet_count"),
        "successful_worksheet_count": report.get("successful_worksheet_count"),
        "failed_worksheet_count": report.get("failed_worksheet_count"),
        "point_count": len(point_ids),
        "record_count": total_records,
        "null_count": total_nulls,
        "time_start": observed_start.isoformat() if observed_start else None,
        "time_end": observed_end.isoformat() if observed_end else None,
        "schema_fingerprint": manifest.schema_fingerprint,
        "parquet_file_count": len(parquet_files),
        "output_size_bytes": sum(
            path.stat().st_size for path in root.rglob("*") if path.is_file()
        ),
        "warnings": report.get("warnings", []),
    }
