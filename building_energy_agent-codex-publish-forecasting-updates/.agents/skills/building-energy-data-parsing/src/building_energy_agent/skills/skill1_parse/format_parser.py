"""Deterministic CSV adapter plus the approved XLSX/XLSM parser."""

from __future__ import annotations

import csv
import hashlib
import json
import shutil
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pyarrow as pa
import pyarrow.parquet as pq

from building_energy_agent.contracts.bundle_layouts import DATASET_BUNDLE_V07
from building_energy_agent.contracts.fingerprints import dataset_schema_fingerprint
from building_energy_agent.contracts.skill1_v07 import DatasetBundleManifest, PointCatalogEntry, Skill1InlineSummary
from building_energy_agent.core.errors import SkillNeedsInputError, SkillParseError
from building_energy_agent.skills.skill1_parse.parser import (
    POINTS_SCHEMA,
    TIMESERIES_SCHEMA,
    ParseOutcome,
    XlsxDatasetParser,
    _ColumnMetadata,
    _counter_median,
    _json_write,
    _numeric_value,
    _timestamp_from_value,
)
from building_energy_agent.skills.skill1_parse.sources import RegisteredSource, sha256_file


CSV_PARSE_RULE_VERSION = "csv-deterministic-v1"
_LONG_REQUIRED = {"timestamp", "point_id", "value_raw"}
_LONG_OPTIONAL = {"name", "description", "unit", "variable_type"}
_TIME_HEADERS = {"timestamp", "time", "datetime", "时间", "日期时间"}


@dataclass(frozen=True, slots=True)
class _CsvReport:
    report: dict[str, Any]
    metadata: dict[str, _ColumnMetadata]
    differences: dict[str, Counter[int]]
    encodings: dict[str, dict[str, float]]


def _csv_bundle_id(sources: list[RegisteredSource], timezone: str | None) -> str:
    identity = {
        "parse_rule_version": CSV_PARSE_RULE_VERSION,
        "source_timezone": timezone,
        "sources": [source.sha256 for source in sources],
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()
    return f"dataset-{hashlib.sha256(encoded).hexdigest()[:20]}-{CSV_PARSE_RULE_VERSION}"


def _partition_name(source_index: int, filename: str) -> str:
    digest = hashlib.sha256(filename.encode("utf-8")).hexdigest()[:8]
    return f"source-{source_index:02d}-csv-{digest}"


def _safe_variable_type(value: str | None) -> str:
    normalized = (value or "continuous").strip().casefold()
    if normalized not in {"continuous", "state", "enum"}:
        raise SkillParseError(f"unsupported variable_type {value!r}")
    return normalized


def _register_metadata(target: dict[str, _ColumnMetadata], value: _ColumnMetadata) -> None:
    existing = target.get(value.point_id)
    if existing is not None and existing.conflict_key != value.conflict_key:
        raise SkillNeedsInputError(
            f"point_id {value.point_id!r} has conflicting metadata: "
            f"{existing.conflict_key!r} versus {value.conflict_key!r}"
        )
    target.setdefault(value.point_id, value)


class DeterministicDatasetParser:
    """Route approved workbook and CSV shapes without guessing layout."""

    def __init__(self, output_root: str | Path) -> None:
        self.output_root = Path(output_root).expanduser().resolve()
        self.xlsx = XlsxDatasetParser(self.output_root)

    def parse(
        self,
        sources: list[RegisteredSource],
        *,
        source_timezone: str | None,
        strict_mode: bool,
    ) -> ParseOutcome:
        suffixes = {source.path.suffix.casefold() for source in sources}
        if suffixes <= {".xlsx", ".xlsm"}:
            return self.xlsx.parse(
                sources,
                source_timezone=source_timezone,
                strict_mode=strict_mode,
            )
        if suffixes != {".csv"}:
            raise SkillNeedsInputError(
                "mixed workbook and CSV requests are ambiguous; submit each format as an independent parse job"
            )
        return self._parse_csv(sources, source_timezone=source_timezone, strict_mode=strict_mode)

    def _parse_csv(
        self,
        sources: list[RegisteredSource],
        *,
        source_timezone: str | None,
        strict_mode: bool,
    ) -> ParseOutcome:
        source_zone: ZoneInfo | None = None
        if source_timezone:
            try:
                source_zone = ZoneInfo(source_timezone)
            except ZoneInfoNotFoundError as exc:
                raise SkillNeedsInputError(f"unknown source_timezone: {source_timezone!r}") from exc

        bundle_id = _csv_bundle_id(sources, source_timezone)
        final_root = self.output_root / bundle_id
        if final_root.exists():
            return self._load_existing(final_root, bundle_id)
        self.output_root.mkdir(parents=True, exist_ok=True)
        temporary_root = Path(tempfile.mkdtemp(prefix=f".{bundle_id}-", dir=self.output_root))
        try:
            outcome = self._build_csv(
                temporary_root,
                bundle_id,
                sources,
                source_zone=source_zone,
                source_timezone=source_timezone,
                strict_mode=strict_mode,
            )
            DATASET_BUNDLE_V07.validate(temporary_root)
            temporary_root.rename(final_root)
            return ParseOutcome(bundle_id, final_root, outcome.summary, outcome.report_summary)
        except Exception:
            shutil.rmtree(temporary_root, ignore_errors=True)
            raise

    def _build_csv(
        self,
        root: Path,
        bundle_id: str,
        sources: list[RegisteredSource],
        *,
        source_zone: ZoneInfo | None,
        source_timezone: str | None,
        strict_mode: bool,
    ) -> ParseOutcome:
        (root / "data" / "timeseries").mkdir(parents=True)
        (root / "data" / "tables").mkdir(parents=True)
        metadata: dict[str, _ColumnMetadata] = {}
        differences: dict[str, Counter[int]] = defaultdict(Counter)
        encodings: dict[str, dict[str, float]] = defaultdict(dict)
        reports: list[dict[str, Any]] = []
        warnings: list[str] = []
        hashes: dict[str, str] = {}
        time_start: datetime | None = None
        time_end: datetime | None = None
        record_count = 0
        null_count = 0
        failed_files = 0

        for source_index, source in enumerate(sources, 1):
            try:
                parsed = self._parse_one_csv(root, source, source_index, source_zone)
            except SkillNeedsInputError:
                raise
            except UnicodeDecodeError as exc:
                failed_files += 1
                error = SkillParseError("CSV must be UTF-8 or UTF-8 BOM text")
                if strict_mode:
                    raise error from exc
                warnings.append(f"source {source.original_filename!r} skipped: {error}")
                continue
            except Exception as exc:
                failed_files += 1
                if strict_mode:
                    raise
                warnings.append(f"source {source.original_filename!r} skipped: {exc}")
                continue
            for value in parsed.metadata.values():
                _register_metadata(metadata, value)
            for point_id, counter in parsed.differences.items():
                differences[point_id].update(counter)
            for point_id, mapping in parsed.encodings.items():
                encodings[point_id].update(mapping)
            report = parsed.report
            reports.append(report)
            hashes[report["output_partition"]] = report["output_sha256"]
            record_count += report["record_count"]
            null_count += report["null_count"]
            current_start = datetime.fromisoformat(report["time_start"])
            current_end = datetime.fromisoformat(report["time_end"])
            time_start = current_start if time_start is None else min(time_start, current_start)
            time_end = current_end if time_end is None else max(time_end, current_end)
        if not reports or time_start is None or time_end is None:
            raise SkillParseError("no supported CSV source was parsed")

        point_rows: list[dict[str, Any]] = []
        for point_id, point in sorted(metadata.items()):
            interval = _counter_median(differences[point_id])
            if interval is None:
                raise SkillNeedsInputError(f"point {point_id!r} has insufficient timestamps to infer interval")
            PointCatalogEntry(
                point_id=point_id,
                name=point.name,
                description=point.description,
                unit=point.unit,
                variable_type=point.variable_type,
                expected_interval_seconds=interval,
            )
            point_rows.append(
                {
                    "point_id": point_id,
                    "name": point.name,
                    "description": point.description,
                    "unit": point.unit,
                    "variable_type": point.variable_type,
                    "expected_interval_seconds": interval,
                }
            )

        points_path = root / "points.parquet"
        pq.write_table(pa.Table.from_pylist(point_rows, schema=POINTS_SCHEMA), points_path, compression="zstd")
        manifest = DatasetBundleManifest(
            dataset_bundle_id=bundle_id,
            schema_fingerprint=dataset_schema_fingerprint(point_rows),
            time_start=time_start,
            time_end=time_end,
        )
        manifest_payload = manifest.model_dump(mode="json")
        manifest_payload["time_start"] = manifest.time_start.isoformat()
        manifest_payload["time_end"] = manifest.time_end.isoformat()
        _json_write(root / "manifest.json", manifest_payload)
        hashes["manifest.json"] = sha256_file(root / "manifest.json")
        hashes["points.parquet"] = sha256_file(points_path)
        report_payload = {
            "dataset_bundle_id": bundle_id,
            "parse_rule_version": CSV_PARSE_RULE_VERSION,
            "source_timezone": source_timezone or "embedded",
            "sources": [
                {
                    "source_ref": source.source_ref,
                    "original_filename": source.original_filename,
                    "size_bytes": source.size_bytes,
                    "sha256": source.sha256,
                }
                for source in sources
            ],
            "worksheet_count": len(reports),
            "successful_worksheet_count": len(reports),
            "failed_worksheet_count": failed_files,
            "point_count": len(point_rows),
            "record_count": record_count,
            "null_count": null_count,
            "time_start": time_start.isoformat(),
            "time_end": time_end.isoformat(),
            "worksheets": reports,
            "state_encodings": encodings,
            "warnings": warnings,
            "output_file_hashes": hashes,
            "output_size_bytes": 0,
        }
        _json_write(root / "parse_report.json", report_payload)
        report_payload["output_size_bytes"] = sum(path.stat().st_size for path in root.rglob("*") if path.is_file())
        _json_write(root / "parse_report.json", report_payload)
        summary = Skill1InlineSummary(
            successful_file_count=len(reports),
            failed_file_count=failed_files,
            successful_worksheet_count=len(reports),
            failed_worksheet_count=failed_files,
            timeseries_table_count=len(reports),
            point_count=len(point_rows),
            record_count=record_count,
            time_range={"time_start": time_start.isoformat(), "time_end": time_end.isoformat()},
            main_warnings=warnings[:20],
        )
        return ParseOutcome(bundle_id, root, summary, report_payload)

    def _parse_one_csv(
        self,
        root: Path,
        source: RegisteredSource,
        source_index: int,
        source_zone: ZoneInfo | None,
    ) -> _CsvReport:
        with source.path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.reader(handle, delimiter=",", strict=True)
            try:
                headers = [value.strip() for value in next(reader)]
            except StopIteration as exc:
                raise SkillParseError("CSV is empty") from exc
            if not headers or any(not value for value in headers):
                raise SkillParseError("CSV headers must be non-empty")
            if len(headers) == 1:
                raise SkillParseError("CSV must use comma delimiters")
            if len(set(headers)) != len(headers):
                raise SkillParseError("CSV contains duplicate column names")
            normalized = [value.casefold() for value in headers]
            if len(set(normalized)) != len(normalized):
                raise SkillParseError("CSV contains case-insensitive duplicate column names")
            normalized_set = set(normalized)
            if _LONG_REQUIRED <= normalized_set:
                extras = normalized_set - _LONG_REQUIRED - _LONG_OPTIONAL
                if extras:
                    raise SkillParseError(f"long-form CSV contains unsupported columns: {sorted(extras)!r}")
                layout = "long"
                time_index = normalized.index("timestamp")
            else:
                time_candidates = [index for index, value in enumerate(normalized) if value in _TIME_HEADERS]
                if len(time_candidates) != 1:
                    raise SkillNeedsInputError("wide-form CSV must contain exactly one unambiguous time column")
                if len(headers) < 2:
                    raise SkillParseError("wide-form CSV must contain at least one point column")
                layout = "wide"
                time_index = time_candidates[0]
            return self._write_csv_rows(
                root,
                source,
                source_index,
                reader,
                headers,
                normalized,
                layout,
                time_index,
                source_zone,
            )

    def _write_csv_rows(
        self,
        root: Path,
        source: RegisteredSource,
        source_index: int,
        reader: csv.reader,
        headers: list[str],
        normalized: list[str],
        layout: str,
        time_index: int,
        source_zone: ZoneInfo | None,
    ) -> _CsvReport:
        partition = _partition_name(source_index, source.original_filename)
        relative_output = f"data/timeseries/sheet={partition}/data.parquet"
        output_path = root / relative_output
        output_path.parent.mkdir(parents=True)
        writer = pq.ParquetWriter(output_path, TIMESERIES_SCHEMA, compression="zstd", use_dictionary=["point_id"])
        timestamps: list[datetime] = []
        point_ids: list[str] = []
        values: list[float | None] = []
        metadata: dict[str, _ColumnMetadata] = {}
        differences: dict[str, Counter[int]] = defaultdict(Counter)
        encodings: dict[str, dict[str, float]] = defaultdict(dict)
        previous: dict[str, datetime] = {}
        time_start: datetime | None = None
        time_end: datetime | None = None
        null_count = 0
        record_count = 0
        invalid_values = 0

        def flush() -> None:
            if not timestamps:
                return
            writer.write_table(
                pa.Table.from_arrays(
                    [
                        pa.array(timestamps, type=TIMESERIES_SCHEMA.field("timestamp").type),
                        pa.array(point_ids, type=pa.string()),
                        pa.array(values, type=pa.float64()),
                    ],
                    schema=TIMESERIES_SCHEMA,
                )
            )
            timestamps.clear()
            point_ids.clear()
            values.clear()

        try:
            for row_number, row in enumerate(reader, 2):
                if not row or all(not value.strip() for value in row):
                    continue
                if len(row) != len(headers):
                    raise SkillParseError(f"CSV row {row_number} has {len(row)} fields; expected {len(headers)}")
                timestamp = _timestamp_from_value(
                    row[time_index],
                    source_zone=source_zone,
                    workbook_epoch=datetime(1899, 12, 30),
                )
                time_start = timestamp if time_start is None else min(time_start, timestamp)
                time_end = timestamp if time_end is None else max(time_end, timestamp)
                if layout == "long":
                    point_id = row[normalized.index("point_id")].strip()
                    if not point_id:
                        raise SkillParseError(f"CSV row {row_number} has an empty point_id")
                    variable_type = _safe_variable_type(row[normalized.index("variable_type")] if "variable_type" in normalized else None)
                    point = _ColumnMetadata(
                        column_index=normalized.index("value_raw"),
                        original_column_name=point_id,
                        point_id=point_id,
                        name=row[normalized.index("name")].strip() if "name" in normalized else point_id,
                        description=row[normalized.index("description")].strip() if "description" in normalized else "",
                        unit=(row[normalized.index("unit")].strip() or None) if "unit" in normalized else None,
                        variable_type=variable_type,
                    )
                    _register_metadata(metadata, point)
                    observations = [(point, row[point.column_index])]
                else:
                    observations = []
                    for column_index, point_id in enumerate(headers):
                        if column_index == time_index:
                            continue
                        point = _ColumnMetadata(
                            column_index=column_index,
                            original_column_name=point_id,
                            point_id=point_id,
                            name=point_id,
                            description="",
                            unit=None,
                            variable_type="continuous",
                        )
                        _register_metadata(metadata, point)
                        observations.append((point, row[column_index]))
                for point, raw_value in observations:
                    number, encoding, invalid = _numeric_value(raw_value, variable_type=point.variable_type)
                    invalid_values += int(invalid)
                    null_count += int(number is None)
                    prior_timestamp = previous.get(point.point_id)
                    if prior_timestamp is not None:
                        delta = round((timestamp - prior_timestamp).total_seconds())
                        if delta > 0:
                            differences[point.point_id][delta] += 1
                    previous[point.point_id] = timestamp
                    if encoding is not None:
                        text, encoded = encoding
                        encodings[point.point_id][text] = encoded
                    timestamps.append(timestamp)
                    point_ids.append(point.point_id)
                    values.append(number)
                    record_count += 1
                if len(timestamps) >= 50_000:
                    flush()
            flush()
        except Exception:
            writer.close()
            output_path.unlink(missing_ok=True)
            raise
        else:
            writer.close()
        if record_count == 0 or time_start is None or time_end is None:
            output_path.unlink(missing_ok=True)
            raise SkillParseError("CSV contains no observations")
        warnings = []
        if invalid_values:
            warnings.append(f"converted {invalid_values} invalid values to null")
        report = {
            "source_ref": source.source_ref,
            "worksheet_name": source.original_filename,
            "layout": layout,
            "status": "succeeded",
            "output_partition": relative_output,
            "output_sha256": sha256_file(output_path),
            "columns": [
                {
                    "original_column_name": point.original_column_name,
                    "point_id": point.point_id,
                    "name": point.name,
                    "description": point.description,
                    "unit": point.unit,
                    "variable_type": point.variable_type,
                }
                for point in metadata.values()
            ],
            "record_count": record_count,
            "null_count": null_count,
            "time_start": time_start.isoformat(),
            "time_end": time_end.isoformat(),
            "warnings": warnings,
        }
        return _CsvReport(report, metadata, differences, encodings)

    def _load_existing(self, root: Path, bundle_id: str) -> ParseOutcome:
        DATASET_BUNDLE_V07.validate(root)
        report = json.loads((root / "parse_report.json").read_text(encoding="utf-8"))
        summary = Skill1InlineSummary(
            successful_file_count=len(report["sources"]),
            successful_worksheet_count=report["successful_worksheet_count"],
            failed_worksheet_count=report["failed_worksheet_count"],
            timeseries_table_count=report["successful_worksheet_count"],
            point_count=report["point_count"],
            record_count=report["record_count"],
            time_range={"time_start": report["time_start"], "time_end": report["time_end"]},
            main_warnings=report.get("warnings", [])[:20],
        )
        return ParseOutcome(bundle_id, root, summary, report)
