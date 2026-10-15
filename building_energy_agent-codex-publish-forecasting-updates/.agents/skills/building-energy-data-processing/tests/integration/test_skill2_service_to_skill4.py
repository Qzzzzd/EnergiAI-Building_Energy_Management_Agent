from __future__ import annotations

import json
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from building_energy_agent.contracts.skill2_v07 import (
    FeatureSpec,
    PredictionSpec,
    ProcessingSpec,
    TargetSpec,
)
from building_energy_agent.skills.skill2_processing.service import (
    Skill2ProcessingService,
)


SKILLS_ROOT = Path(__file__).resolve().parents[3]
SKILL4_SCRIPTS = SKILLS_ROOT / "building-energy-load-forecasting" / "scripts"
sys.path.insert(0, str(SKILL4_SCRIPTS))

from load_forecasting.bundle import (  # noqa: E402
    load_processing_bundle,
    validate_and_expand,
)


def _write_eleven_day_dataset_bundle(artifact_root: Path) -> str:
    bundle_id = "dataset-eleven-complete-days"
    bundle = artifact_root / "dataset-bundles" / bundle_id
    partition = "data/timeseries/sheet=selected-load/data.parquet"
    (bundle / "data" / "timeseries" / "sheet=selected-load").mkdir(
        parents=True
    )
    (bundle / "data" / "tables").mkdir(parents=True)

    start = datetime(2026, 1, 1, tzinfo=UTC)
    row_count = 11 * 1_440
    timestamps = [
        start + offset * timedelta(minutes=1) for offset in range(row_count)
    ]
    pq.write_table(
        pa.table(
            {
                "timestamp": pa.array(
                    timestamps,
                    type=pa.timestamp("us", tz="UTC"),
                ),
                "point_id": pa.array(["BMS-TARGET"] * row_count),
                "value_raw": pa.array(
                    [float(offset) for offset in range(row_count)],
                    type=pa.float64(),
                ),
            }
        ),
        bundle / partition,
        compression="zstd",
    )
    exogenous_partition = "data/timeseries/sheet=it-power/data.parquet"
    (bundle / "data" / "timeseries" / "sheet=it-power").mkdir(parents=True)
    pq.write_table(
        pa.table(
            {
                "timestamp": pa.array(
                    timestamps,
                    type=pa.timestamp("us", tz="UTC"),
                ),
                "point_id": pa.array(["BMS-IT-POWER"] * row_count),
                "value_raw": pa.array(
                    [float(offset % 1_440) for offset in range(row_count)],
                    type=pa.float64(),
                ),
            }
        ),
        bundle / exogenous_partition,
        compression="zstd",
    )
    pq.write_table(
        pa.Table.from_pylist(
            [
                {
                    "point_id": "BMS-TARGET",
                    "name": "总冷机冷负荷",
                    "description": "Synthetic total chiller load target",
                    "unit": "kW",
                    "variable_type": "continuous",
                    "expected_interval_seconds": 60,
                },
                {
                    "point_id": "BMS-IT-POWER",
                    "name": "IT总功率",
                    "description": "Synthetic IT power",
                    "unit": "kW",
                    "variable_type": "continuous",
                    "expected_interval_seconds": 60,
                },
            ]
        ),
        bundle / "points.parquet",
        compression="zstd",
    )
    (bundle / "manifest.json").write_text(
        json.dumps(
            {
                "bundle_type": "DatasetBundle",
                "bundle_version": "0.7",
                "dataset_bundle_id": bundle_id,
                "schema_fingerprint": "a" * 64,
                "time_start": timestamps[0].isoformat(),
                "time_end": timestamps[-1].isoformat(),
            }
        ),
        encoding="utf-8",
    )
    (bundle / "parse_report.json").write_text(
        json.dumps(
            {
                "dataset_bundle_id": bundle_id,
                "worksheets": [
                    {
                        "worksheet_name": "总冷机冷负荷",
                        "status": "succeeded",
                        "output_partition": partition,
                        "columns": [
                            {
                                "original_column_name": "BMS-TARGET",
                                "point_id": "BMS-TARGET",
                                "name": "总冷机冷负荷",
                                "description": (
                                    "Synthetic total chiller load target"
                                ),
                                "unit": "kW",
                            }
                        ],
                    },
                    {
                        "worksheet_name": "IT功率",
                        "status": "succeeded",
                        "output_partition": exogenous_partition,
                        "columns": [
                            {
                                "original_column_name": "BMS-IT-POWER",
                                "point_id": "BMS-IT-POWER",
                                "name": "IT总功率",
                                "description": "Synthetic IT power",
                                "unit": "kW",
                            }
                        ],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    return bundle_id


@pytest.mark.integration
def test_skill2_service_builds_bundle_consumed_by_skill4(tmp_path: Path) -> None:
    source_bundle_id = _write_eleven_day_dataset_bundle(tmp_path)
    service = Skill2ProcessingService(tmp_path)
    request = ProcessingSpec(
        source_bundle_id=source_bundle_id,
        target=TargetSpec(point_id="BMS-TARGET"),
        prediction_spec=PredictionSpec(forecast_horizon="1h"),
        feature_spec=FeatureSpec(preset="target-history-v1"),
        data_scope={"local_timezone": "UTC"},
        split_spec={"anchor_time": "00:00"},
    )

    started = service.start(request)

    assert started.status == "succeeded"
    result = service.result(started.job_id)
    assert result.summary["split_sample_counts"] == {
        "train": 6,
        "validation": 2,
        "test": 2,
    }
    assert result.summary["forecast_index_row_count"] == 10 * 60
    assert result.summary["label_row_count"] == 10 * 60

    bundle = load_processing_bundle(
        tmp_path,
        result.processing_bundle_id,
        "backtest",
    )
    expanded, model_features, categorical = validate_and_expand(
        bundle,
        "train",
        True,
    )

    assert len(expanded) == 6 * 60
    assert model_features == [
        "target_lag_1min",
        "target_lag_60min",
        "target_lag_1440min",
        "target_mean_60min",
        "target_mean_1440min",
        "calendar_hour",
        "calendar_weekday",
        "calendar_month",
        "horizon_step",
    ]
    assert categorical == []
    first_feature = bundle.load_split("features", "train").iloc[0]
    assert first_feature["target_lag_1min"] == pytest.approx(1_439.0)
    assert first_feature["target_lag_60min"] == pytest.approx(1_380.0)
    assert first_feature["target_lag_1440min"] == pytest.approx(0.0)
    assert first_feature["target_mean_60min"] == pytest.approx(1_409.5)
    assert first_feature["target_mean_1440min"] == pytest.approx(719.5)
    assert (
        bundle.root / "data" / "processed_timeseries" / "target.parquet"
    ).is_file()
    assert bundle.manifest["leakage_check_status"] == "passed"


@pytest.mark.integration
def test_skill2_service_accepts_twenty_four_hour_default(
    tmp_path: Path,
) -> None:
    source_bundle_id = _write_eleven_day_dataset_bundle(tmp_path)
    service = Skill2ProcessingService(tmp_path)

    started = service.start(
        ProcessingSpec(
            source_bundle_id=source_bundle_id,
            target=TargetSpec(point_id="BMS-TARGET"),
            prediction_spec=PredictionSpec(),
            feature_spec=FeatureSpec(),
            data_scope={"local_timezone": "UTC"},
            split_spec={"anchor_time": "00:00"},
        )
    )

    assert started.status == "succeeded"
    result = service.result(started.job_id)
    assert result.summary["horizon_minutes"] == 1_440
    assert result.summary["feature_rule_version"] == "building-energy-history-v2"
    bundle = load_processing_bundle(
        tmp_path,
        result.processing_bundle_id,
        "backtest",
    )
    assert "target_lag_5min" in bundle.feature_names
    assert "target_std_1440min" in bundle.feature_names
    assert "target_delta_180min" in bundle.feature_names
    assert "exog_01_last" in bundle.feature_names
    assert "exog_01_mean_60min" in bundle.feature_names
    first = bundle.load_split("features", "train").iloc[0]
    assert first["exog_01_last"] == pytest.approx(1_439.0)
    assert first["exog_01_mean_60min"] == pytest.approx(1_409.5)


@pytest.mark.integration
def test_skill2_service_builds_future_bundle_after_last_observation(
    tmp_path: Path,
) -> None:
    source_bundle_id = _write_eleven_day_dataset_bundle(tmp_path)
    service = Skill2ProcessingService(tmp_path)
    started = service.start(
        ProcessingSpec(
            source_bundle_id=source_bundle_id,
            target=TargetSpec(point_id="BMS-TARGET"),
            prediction_spec=PredictionSpec(),
            feature_spec=FeatureSpec(),
            data_scope={"local_timezone": "UTC", "processing_mode": "future"},
            split_spec={},
        )
    )

    assert started.status == "succeeded"
    result = service.result(started.job_id)
    assert result.summary["mode"] == "future"
    assert result.summary["forecast_index_row_count"] == 1_440
    bundle = load_processing_bundle(
        tmp_path,
        result.processing_bundle_id,
        "future",
    )
    expanded, model_features, categorical = validate_and_expand(
        bundle,
        "future",
        False,
    )
    assert len(expanded) == 1_440
    assert categorical == []
    assert "exog_01_last" in model_features
    assert expanded["target_timestamp"].min() == datetime(
        2026,
        1,
        12,
        tzinfo=UTC,
    )
