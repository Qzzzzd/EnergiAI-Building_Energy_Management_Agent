from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from building_energy_agent.cli import main
from building_energy_agent.skills.skill2_processing.preflight import (
    DatasetBundleReader,
    TargetResolver,
    run_skill2_preflight,
    v07_target_compatibility_error,
)


def _write_bundle(
    tmp_path: Path,
    target_point_ids: list[str] | None = None,
) -> Path:
    point_ids = target_point_ids if target_point_ids is not None else ["P-OTHER"]
    bundle = tmp_path / "dataset-synthetic-v07"
    partition = "data/timeseries/sheet=synthetic/data.parquet"
    (bundle / "data" / "timeseries" / "sheet=synthetic").mkdir(parents=True)
    (bundle / "data" / "tables").mkdir(parents=True)

    start = datetime(2026, 1, 1, tzinfo=UTC)
    timestamps = [
        start,
        start + timedelta(seconds=60),
        start + timedelta(seconds=60),
        start + timedelta(seconds=180),
        start + timedelta(seconds=240),
    ]
    pq.write_table(
        pa.table(
            {
                "timestamp": pa.array(
                    timestamps * len(point_ids), type=pa.timestamp("us", tz="UTC")
                ),
                "point_id": pa.array(
                    [point_id for point_id in point_ids for _ in timestamps]
                ),
                "value_raw": pa.array(
                    [10.0, None, 11.0, 12.0, 13.0] * len(point_ids),
                    type=pa.float64(),
                ),
            }
        ),
        bundle / partition,
    )
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "point_id": point_id,
                    "name": f"name-{point_id}",
                    "description": f"description-{point_id}",
                    "unit": "kW",
                    "variable_type": "continuous",
                    "expected_interval_seconds": 60,
                }
                for point_id in point_ids
            ]
        ),
        bundle / "points.parquet",
    )
    manifest = {
        "bundle_type": "DatasetBundle",
        "bundle_version": "0.7",
        "dataset_bundle_id": bundle.name,
        "schema_fingerprint": "a" * 64,
        "time_start": start.isoformat(),
        "time_end": (start + timedelta(seconds=240)).isoformat(),
    }
    (bundle / "manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    worksheet_name = "总冷机冷负荷" if target_point_ids is not None else "其他负荷"
    report = {
        "dataset_bundle_id": bundle.name,
        "worksheets": [
            {
                "worksheet_name": worksheet_name,
                "status": "succeeded",
                "output_partition": partition,
                "columns": [
                    {
                        "original_column_name": point_id,
                        "point_id": point_id,
                        "name": f"name-{point_id}",
                        "description": f"description-{point_id}",
                        "unit": "kW",
                    }
                    for point_id in point_ids
                ],
            }
        ],
    }
    (bundle / "parse_report.json").write_text(
        json.dumps(report, ensure_ascii=False), encoding="utf-8"
    )
    return bundle


def test_dataset_bundle_reader_reads_metadata_and_filtered_partition(
    tmp_path: Path,
) -> None:
    bundle = _write_bundle(tmp_path, ["P-TARGET", "P-OTHER"])
    reader = DatasetBundleReader(bundle)

    table = reader.read_point_timeseries(
        "P-TARGET", reader.point_partitions("P-TARGET")[0]
    )

    assert reader.manifest.dataset_bundle_id == bundle.name
    assert set(reader.points) == {"P-TARGET", "P-OTHER"}
    assert table.column_names == ["timestamp", "point_id", "value_raw"]
    assert table.num_rows == 5
    assert set(table["point_id"].to_pylist()) == {"P-TARGET"}


def test_target_resolver_returns_unique_exact_worksheet_candidate(
    tmp_path: Path,
) -> None:
    resolution = TargetResolver(
        DatasetBundleReader(_write_bundle(tmp_path, ["P-TARGET"]))
    ).resolve()

    assert resolution.needs_input is False
    assert resolution.source_target_point_id == "P-TARGET"
    assert resolution.source_partition.endswith("data.parquet")


def test_target_resolver_needs_input_when_target_worksheet_is_absent(
    tmp_path: Path,
) -> None:
    resolution = TargetResolver(
        DatasetBundleReader(_write_bundle(tmp_path, None))
    ).resolve()

    assert resolution.needs_input is True
    assert resolution.candidates == []
    assert "no source point" in (resolution.needs_input_reason or "")


def test_target_resolver_needs_input_for_multiple_candidates(
    tmp_path: Path,
) -> None:
    resolution = TargetResolver(
        DatasetBundleReader(_write_bundle(tmp_path, ["P-ONE", "P-TWO"]))
    ).resolve()

    assert resolution.needs_input is True
    assert {candidate.point_id for candidate in resolution.candidates} == {
        "P-ONE",
        "P-TWO",
    }


def test_target_resolver_honors_explicit_point_id(tmp_path: Path) -> None:
    reader = DatasetBundleReader(
        _write_bundle(tmp_path, ["P-FIRST", "P-REQUESTED"])
    )

    resolution = TargetResolver(reader).resolve("P-REQUESTED")

    assert resolution.needs_input is False
    assert resolution.source_target_point_id == "P-REQUESTED"


def test_v07_target_semantics_reject_other_load(tmp_path: Path) -> None:
    reader = DatasetBundleReader(_write_bundle(tmp_path, None))
    resolution = TargetResolver(reader).resolve("P-OTHER")

    assert "total chiller load" in (
        v07_target_compatibility_error(reader, resolution) or ""
    )


def test_v07_target_semantics_accept_total_chiller_load(tmp_path: Path) -> None:
    reader = DatasetBundleReader(_write_bundle(tmp_path, ["P-TARGET"]))
    resolution = TargetResolver(reader).resolve("P-TARGET")

    assert v07_target_compatibility_error(reader, resolution) is None


def test_target_resolver_needs_input_for_unknown_explicit_point(
    tmp_path: Path,
) -> None:
    resolution = TargetResolver(
        DatasetBundleReader(_write_bundle(tmp_path, ["P-TARGET"]))
    ).resolve("P-MISSING")

    assert resolution.needs_input is True
    assert "was not found" in (resolution.needs_input_reason or "")


def test_target_profile_reports_null_duplicate_and_intervals(tmp_path: Path) -> None:
    profile = run_skill2_preflight(_write_bundle(tmp_path, ["P-TARGET"]))

    assert profile.total_rows == 5
    assert profile.non_null_rows == 4
    assert profile.null_rows == 1
    assert profile.duplicate_timestamp_count == 1
    assert profile.monotonic is True
    assert profile.observed_interval_distribution == {"60": 2, "120": 1}
    assert profile.irregular_interval_count == 1


def test_skill2_preflight_cli_success(tmp_path: Path, capsys: object) -> None:
    bundle = _write_bundle(tmp_path, ["P-TARGET"])

    exit_code = main(["skill2-preflight", "--bundle", str(bundle)])
    payload = json.loads(capsys.readouterr().out)  # type: ignore[attr-defined]

    assert exit_code == 0
    assert payload["status"] == "succeeded"
    assert payload["source_target_point_id"] == "P-TARGET"
    assert "value_raw" not in payload
