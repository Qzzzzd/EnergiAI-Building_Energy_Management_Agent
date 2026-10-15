from __future__ import annotations

import json
import math
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .bundle import schema_fingerprint
from .util import content_id, sha256_file


def _catalog() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {"feature_name": "load_lag_1", "data_type": "numeric", "source_point_id": "总冷机冷负荷", "semantic_version": "1"},
            {"feature_name": "outdoor_temp", "data_type": "numeric", "source_point_id": "室外温度", "semantic_version": "1"},
            {"feature_name": "chiller_enabled", "data_type": "boolean", "source_point_id": "冷机启停", "semantic_version": "1"},
            {"feature_name": "operating_mode", "data_type": "categorical", "source_point_id": "运行模式", "semantic_version": "1"},
        ]
    )


def _features(sample_ids: list[str], starts: list[pd.Timestamp]) -> pd.DataFrame:
    rows = []
    for index, (sample_id, start_value) in enumerate(zip(sample_ids, starts, strict=True)):
        start = pd.Timestamp(start_value)
        rows.append(
            {
                "sample_id": sample_id,
                "feature_cutoff_timestamp": start,
                "forecast_start_timestamp": start,
                "forecast_end_timestamp": start + pd.Timedelta(7, unit="h"),
                "load_lag_1": np.nan if index == 2 else 70.0 + index * 1.5,
                "outdoor_temp": 23.0 + 4 * math.sin(index / 3),
                "chiller_enabled": bool(index % 5 != 0),
                "operating_mode": int(index % 3),
            }
        )
    return pd.DataFrame(rows)


def _index(sample_ids: list[str], starts: list[pd.Timestamp]) -> pd.DataFrame:
    rows = []
    for sample_id, start_value in zip(sample_ids, starts, strict=True):
        start = pd.Timestamp(start_value)
        for step in range(8):
            timestamp = start + pd.Timedelta(step, unit="h")
            rows.append(
                {
                    "sample_id": sample_id,
                    "target_timestamp": timestamp,
                    "horizon_step": step + 1,
                    "horizon_duration": str(pd.Timedelta(step, unit="h")),
                    "calendar_hour": timestamp.hour,
                    "calendar_weekday": timestamp.weekday(),
                    "calendar_month": timestamp.month,
                }
            )
    return pd.DataFrame(rows)


def _labels(index: pd.DataFrame, features: pd.DataFrame, missing_last: bool = False) -> pd.DataFrame:
    merged = index.merge(features[["sample_id", "load_lag_1", "outdoor_temp", "chiller_enabled", "operating_mode"]], on="sample_id")
    lag = merged["load_lag_1"].fillna(72)
    target = lag + 2.2 * merged["calendar_hour"] + 1.3 * merged["outdoor_temp"] + 5 * merged["chiller_enabled"] + 3 * merged["operating_mode"]
    labels = merged[["sample_id", "target_timestamp"]].copy()
    labels["target_value"] = target
    if missing_last:
        labels.loc[labels.index[-2:], "target_value"] = np.nan
    return labels


def create_mock_processing_bundle(
    artifact_root: Path,
    mode: str = "backtest",
    forecast_start: str = "2025-10-01T00:00:00",
) -> dict[str, Any]:
    if mode not in {"backtest", "future"}:
        raise ValueError(mode)
    catalog = _catalog()
    identity = {"mode": mode, "forecast_start": forecast_start, "fixture_version": 2}
    bundle_id = content_id("processing", identity)
    root = artifact_root / "processing-bundles" / bundle_id
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    catalog.to_parquet(root / "feature_catalog.parquet", index=False)
    target = {"target_point_id": "总冷机冷负荷", "target_name": "总冷机冷负荷", "target_unit": "kW"}
    (root / "target_metadata.json").write_text(json.dumps(target, ensure_ascii=False, indent=2), encoding="utf-8")
    mappings = {"operating_mode": {"unknown": -1, "values": {"-1": "unknown", "0": "off", "1": "cooling", "2": "free_cooling"}}}
    (root / "categorical_mappings.json").write_text(json.dumps(mappings, ensure_ascii=False, indent=2), encoding="utf-8")

    split_summary: dict[str, Any] = {}
    if mode == "backtest":
        split_inputs = {
            "train": ([f"train-{i:03d}" for i in range(24)], list(pd.date_range("2025-06-01", periods=24, freq="D"))),
            "validation": (["validation-000"], [pd.Timestamp("2025-08-01")]),
            "test": (["test-000"], [pd.Timestamp("2025-09-01")]),
        }
    else:
        start = pd.Timestamp(forecast_start)
        split_inputs = {"future": (["future-000"], [start])}
    for split, (sample_ids, starts) in split_inputs.items():
        features = _features(sample_ids, starts)
        index = _index(sample_ids, starts)
        feature_dir = root / "features" / f"split={split}"
        index_dir = root / "forecast_index" / f"split={split}"
        feature_dir.mkdir(parents=True)
        index_dir.mkdir(parents=True)
        features.to_parquet(feature_dir / "data.parquet", index=False)
        index.to_parquet(index_dir / "data.parquet", index=False)
        if mode == "backtest":
            label_dir = root / "labels" / f"split={split}"
            label_dir.mkdir(parents=True)
            _labels(index, features, missing_last=split == "test").to_parquet(label_dir / "data.parquet", index=False)
        split_summary[split] = {
            "sample_count": len(sample_ids),
            "forecast_start": pd.Timestamp(min(starts)).isoformat(),
            "forecast_end": (pd.Timestamp(max(starts)) + pd.Timedelta(7, unit="h")).isoformat(),
        }
    (root / "split_manifest.json").write_text(json.dumps({"splits": split_summary}, indent=2), encoding="utf-8")
    file_hashes = {
        path.relative_to(root).as_posix(): sha256_file(path)
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }
    manifest = {
        "bundle_type": "ProcessingBundle",
        "bundle_version": "0.7",
        "processing_bundle_id": bundle_id,
        "processing_mode": mode,
        "leakage_check_status": "passed",
        "leakage_check_rule_version": "leakage-v1",
        "processing_rule_version": "processing-v0.7",
        "data_granularity": "1h",
        "feature_schema_fingerprint": schema_fingerprint(catalog),
        "file_hashes": file_hashes,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "processing_bundle_id": bundle_id,
        "mode": mode,
        "path": str(root),
        "forecast_start": pd.Timestamp(min(starts)).isoformat() if mode == "future" else None,
        "forecast_end": (pd.Timestamp(max(starts)) + pd.Timedelta(7, unit="h")).isoformat() if mode == "future" else None,
    }
