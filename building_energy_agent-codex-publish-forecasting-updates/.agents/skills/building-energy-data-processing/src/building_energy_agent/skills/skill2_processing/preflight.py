"""Read-only Skill 2 input inspection for a V0.7 DatasetBundle."""

from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from pydantic import BaseModel, ConfigDict, Field

from building_energy_agent.contracts.bundle_layouts import DATASET_BUNDLE_V07
from building_energy_agent.contracts.skill1_v07 import (
    DatasetBundleManifest,
    PointCatalogEntry,
)

TIMESERIES_COLUMNS = ("timestamp", "point_id", "value_raw")


class TargetCandidate(BaseModel):
    """Small, value-free summary of one source target candidate."""

    model_config = ConfigDict(extra="forbid")

    point_id: str
    worksheet_name: str
    source_partition: str
    original_column_name: str = ""
    name: str = ""
    description: str = ""
    unit: str | None = None


class TargetResolution(BaseModel):
    """Result of resolving the compatibility target to one source point."""

    model_config = ConfigDict(extra="forbid")

    source_target_point_id: str | None = None
    source_partition: str | None = None
    candidates: list[TargetCandidate] = Field(default_factory=list)
    needs_input: bool = False
    needs_input_reason: str | None = None


class Skill2InputProfile(BaseModel):
    """Internal, read-only preflight result; not a cross-Skill contract."""

    model_config = ConfigDict(extra="forbid")

    dataset_bundle_id: str
    source_target_point_id: str | None
    target_point_id: str | None = None
    target_name: str | None = None
    target_unit: str | None = None
    source_partition: str | None
    time_start: datetime | None = None
    time_end: datetime | None = None
    total_rows: int = 0
    non_null_rows: int = 0
    null_rows: int = 0
    duplicate_timestamp_count: int = 0
    monotonic: bool = True
    expected_interval_seconds: int | None = None
    observed_interval_distribution: dict[str, int] = Field(default_factory=dict)
    irregular_interval_count: int = 0
    warnings: list[str] = Field(default_factory=list)
    needs_input: bool = False
    needs_input_reason: str | None = None
    candidates: list[TargetCandidate] = Field(default_factory=list)


class DatasetBundleReader:
    """Lightweight DatasetBundle metadata and selected-partition reader."""

    def __init__(self, bundle_path: str | Path) -> None:
        self.root = Path(bundle_path).expanduser().resolve()
        DATASET_BUNDLE_V07.validate(self.root)

        manifest_payload = self._read_json("manifest.json")
        self.manifest = DatasetBundleManifest.model_validate(manifest_payload)
        if self.root.name != self.manifest.dataset_bundle_id:
            raise ValueError(
                "DatasetBundle directory name must equal manifest dataset_bundle_id"
            )

        self.parse_report = self._read_json("parse_report.json")
        if self.parse_report.get("dataset_bundle_id") != self.manifest.dataset_bundle_id:
            raise ValueError("parse_report dataset_bundle_id does not match manifest")
        worksheets = self.parse_report.get("worksheets")
        if not isinstance(worksheets, list):
            raise ValueError("parse_report worksheets must be a list")
        self.worksheets: list[dict[str, Any]] = worksheets

        points_table = pq.read_table(self.root / "points.parquet")
        required_point_columns = set(PointCatalogEntry.model_fields)
        missing_columns = required_point_columns - set(points_table.column_names)
        if missing_columns:
            raise ValueError(
                "points.parquet is missing required columns: "
                f"{sorted(missing_columns)!r}"
            )
        self.points: dict[str, PointCatalogEntry] = {}
        for row in points_table.select(sorted(required_point_columns)).to_pylist():
            point = PointCatalogEntry.model_validate(row)
            if point.point_id in self.points:
                raise ValueError(
                    f"points.parquet contains duplicate point_id {point.point_id!r}"
                )
            self.points[point.point_id] = point

    def point_partitions(self, point_id: str) -> tuple[str, ...]:
        """Locate successful time-series partitions mapped to ``point_id``."""

        partitions: list[str] = []
        for worksheet in self.worksheets:
            if worksheet.get("status") != "succeeded":
                continue
            columns = worksheet.get("columns")
            if not isinstance(columns, list):
                raise ValueError("successful worksheet columns must be a list")
            if any(
                isinstance(column, dict) and column.get("point_id") == point_id
                for column in columns
            ):
                relative_path = worksheet.get("output_partition")
                self._partition_path(relative_path)
                if relative_path not in partitions:
                    partitions.append(relative_path)
        return tuple(partitions)

    def read_point_timeseries(
        self,
        point_id: str,
        source_partition: str,
    ) -> pa.Table:
        """Read only the requested point and three required columns."""

        if source_partition not in self.point_partitions(point_id):
            raise ValueError(
                f"partition {source_partition!r} is not mapped to point {point_id!r}"
            )
        return pq.read_table(
            self._partition_path(source_partition),
            columns=list(TIMESERIES_COLUMNS),
            filters=[("point_id", "=", point_id)],
        )

    def _read_json(self, relative_path: str) -> dict[str, Any]:
        payload = json.loads(
            (self.root / relative_path).read_text(encoding="utf-8")
        )
        if not isinstance(payload, dict):
            raise ValueError(f"{relative_path} must contain a JSON object")
        return payload

    def _partition_path(self, relative_path: Any) -> Path:
        if not isinstance(relative_path, str):
            raise ValueError("worksheet output_partition must be a string")
        relative = PurePosixPath(relative_path)
        if (
            not relative_path
            or relative.is_absolute()
            or ".." in relative.parts
            or relative_path == "."
        ):
            raise ValueError("output_partition must be a safe bundle-relative path")
        path = (self.root / Path(*relative.parts)).resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            raise ValueError(
                "output_partition does not identify a bundle file: "
                f"{relative_path!r}"
            )
        return path


class TargetResolver:
    """Resolve the logical target using exact Skill 1 worksheet lineage."""

    def __init__(self, reader: DatasetBundleReader) -> None:
        self.reader = reader

    def resolve(self, requested_point_id: str | None = None) -> TargetResolution:
        if requested_point_id is not None:
            return self._resolve_requested_point(requested_point_id)

        candidates: list[TargetCandidate] = []
        for worksheet in self.reader.worksheets:
            if worksheet.get("status") != "succeeded":
                continue
            source_partition = worksheet.get("output_partition")
            self.reader._partition_path(source_partition)
            columns = worksheet.get("columns")
            if not isinstance(columns, list):
                raise ValueError("successful worksheet columns must be a list")
            for column in columns:
                if not isinstance(column, dict):
                    raise ValueError("worksheet column mapping must be an object")
                point_id = column.get("point_id")
                if not isinstance(point_id, str) or point_id not in self.reader.points:
                    continue
                point = self.reader.points[point_id]
                candidates.append(
                    TargetCandidate(
                        point_id=point_id,
                        worksheet_name=str(worksheet.get("worksheet_name") or ""),
                        source_partition=source_partition,
                        original_column_name=str(
                            column.get("original_column_name") or ""
                        ),
                        name=point.name,
                        description=point.description,
                        unit=point.unit,
                    )
                )

        unique_candidates = {
            (candidate.point_id, candidate.source_partition): candidate
            for candidate in candidates
        }
        resolved_candidates = list(unique_candidates.values())
        if len(resolved_candidates) == 1:
            candidate = resolved_candidates[0]
            return TargetResolution(
                source_target_point_id=candidate.point_id,
                source_partition=candidate.source_partition,
                candidates=resolved_candidates,
            )
        if not resolved_candidates:
            return TargetResolution(
                needs_input=True,
                needs_input_reason="no continuous source point was found",
            )
        return TargetResolution(
            candidates=resolved_candidates,
            needs_input=True,
            needs_input_reason="multiple continuous source points were found; select one explicitly",
        )

    def _resolve_requested_point(self, point_id: str) -> TargetResolution:
        point = self.reader.points.get(point_id)
        if point is None:
            return TargetResolution(
                needs_input=True,
                needs_input_reason=f"requested target point {point_id!r} was not found",
            )
        partitions = self.reader.point_partitions(point_id)
        if len(partitions) != 1:
            return TargetResolution(
                needs_input=True,
                needs_input_reason=(
                    f"requested target point {point_id!r} maps to "
                    f"{len(partitions)} partitions; exactly one is required"
                ),
            )
        worksheet_name = ""
        original_column_name = ""
        for worksheet in self.reader.worksheets:
            if worksheet.get("output_partition") != partitions[0]:
                continue
            worksheet_name = str(worksheet.get("worksheet_name") or "")
            for column in worksheet.get("columns", []):
                if isinstance(column, dict) and column.get("point_id") == point_id:
                    original_column_name = str(
                        column.get("original_column_name") or ""
                    )
                    break
        candidate = TargetCandidate(
            point_id=point_id,
            worksheet_name=worksheet_name,
            source_partition=partitions[0],
            original_column_name=original_column_name,
            name=point.name,
            description=point.description,
            unit=point.unit,
        )
        return TargetResolution(
            source_target_point_id=point_id,
            source_partition=partitions[0],
            candidates=[candidate],
        )


def v07_target_compatibility_error(
    reader: DatasetBundleReader,
    resolution: TargetResolution,
) -> str | None:
    """Return why a resolved point cannot be used as a load target."""

    point_id = resolution.source_target_point_id
    if point_id is None or not resolution.candidates:
        return "target resolution is incomplete"
    point = reader.points[point_id]
    if point.variable_type != "continuous":
        return "load forecasting target must be continuous"
    return None


def run_skill2_preflight(
    bundle_path: str | Path,
    requested_point_id: str | None = None,
) -> Skill2InputProfile:
    """Resolve and profile the target without modifying source observations."""

    reader = DatasetBundleReader(bundle_path)
    resolution = TargetResolver(reader).resolve(requested_point_id)
    if resolution.needs_input:
        return Skill2InputProfile(
            dataset_bundle_id=reader.manifest.dataset_bundle_id,
            source_target_point_id=None,
            source_partition=None,
            needs_input=True,
            needs_input_reason=resolution.needs_input_reason,
            candidates=resolution.candidates,
        )

    point_id = resolution.source_target_point_id
    source_partition = resolution.source_partition
    if point_id is None or source_partition is None:
        raise AssertionError("successful target resolution is incomplete")
    table = reader.read_point_timeseries(point_id, source_partition)
    _validate_target_table(table, point_id)

    timestamps = table["timestamp"].to_pylist()
    unique_timestamps = sorted(set(timestamps))
    duplicate_count = len(timestamps) - len(unique_timestamps)
    monotonic = all(
        current >= previous
        for previous, current in zip(timestamps, timestamps[1:], strict=False)
    )
    intervals = Counter(
        round((current - previous).total_seconds())
        for previous, current in zip(
            unique_timestamps, unique_timestamps[1:], strict=False
        )
        if current > previous
    )
    point = reader.points[point_id]
    irregular_count = sum(
        count
        for seconds, count in intervals.items()
        if seconds != point.expected_interval_seconds
    )
    null_rows = table["value_raw"].null_count
    warnings: list[str] = []
    if null_rows:
        warnings.append(f"target contains {null_rows} null value(s)")
    if duplicate_count:
        warnings.append(
            f"target contains {duplicate_count} duplicate timestamp row(s)"
        )
    if not monotonic:
        warnings.append("target timestamps are not monotonic")
    if irregular_count:
        warnings.append(
            f"target contains {irregular_count} interval(s) different from "
            f"the expected {point.expected_interval_seconds} seconds"
        )

    return Skill2InputProfile(
        dataset_bundle_id=reader.manifest.dataset_bundle_id,
        source_target_point_id=point_id,
        target_point_id=point_id,
        target_name=point.description or point.name or point_id,
        target_unit=point.unit,
        source_partition=source_partition,
        time_start=unique_timestamps[0] if unique_timestamps else None,
        time_end=unique_timestamps[-1] if unique_timestamps else None,
        total_rows=table.num_rows,
        non_null_rows=table.num_rows - null_rows,
        null_rows=null_rows,
        duplicate_timestamp_count=duplicate_count,
        monotonic=monotonic,
        expected_interval_seconds=point.expected_interval_seconds,
        observed_interval_distribution={
            str(seconds): intervals[seconds] for seconds in sorted(intervals)
        },
        irregular_interval_count=irregular_count,
        warnings=warnings,
        candidates=resolution.candidates,
    )


def _validate_target_table(table: pa.Table, point_id: str) -> None:
    if table.column_names != list(TIMESERIES_COLUMNS):
        raise ValueError("target table does not contain the requested columns")
    timestamp_type = table.schema.field("timestamp").type
    if not pa.types.is_timestamp(timestamp_type) or timestamp_type.tz is None:
        raise ValueError("target timestamp must be timezone-aware")
    timestamps = table["timestamp"].to_pylist()
    if any(
        timestamp is None
        or timestamp.tzinfo is None
        or timestamp.utcoffset() != UTC.utcoffset(timestamp)
        for timestamp in timestamps
    ):
        raise ValueError("target timestamp must use UTC")
    if table.num_rows and not pc.all(
        pc.equal(table["point_id"], pa.scalar(point_id))
    ).as_py():
        raise ValueError("target partition contains an unexpected point_id")
    value_type = table.schema.field("value_raw").type
    if not (
        pa.types.is_integer(value_type)
        or pa.types.is_floating(value_type)
        or pa.types.is_decimal(value_type)
    ):
        raise ValueError("target value_raw must be numeric or null")
