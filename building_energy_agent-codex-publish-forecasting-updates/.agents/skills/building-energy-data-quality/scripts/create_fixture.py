#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd


CORE = [
    ("target-load", "总冷机冷负荷", "总冷机冷负荷", "kW", "continuous", 60),
    ("it-total", "IT设备总功率", "IT设备总功率", "kW", "continuous", 60),
    ("wet-bulb", "湿球温度", "室外湿球温度", "℃", "continuous", 60),
    ("chw-supply", "冷冻水供水温度", "冷冻水供水温度", "℃", "continuous", 60),
    ("chw-return", "冷冻水回水温度", "冷冻水回水温度", "℃", "continuous", 60),
    ("room-temp", "房间温度", "机房房间温度", "℃", "continuous", 60),
    ("chiller-power", "总冷机电负荷", "总冷机电负荷", "kW", "continuous", 60),
    ("chiller-state", "冷机启停状态", "冷机启停状态", None, "state", 300),
    ("free-cooling", "免费制冷开启状态信息", "免费制冷模式", None, "enum", 300),
]


def create_fixture(artifact_root: Path, bundle_id: str, point_count: int = 9, periods: int = 180) -> Path:
    if point_count < len(CORE):
        raise ValueError(f"point_count must be at least {len(CORE)}")
    root = artifact_root / "dataset-bundles" / bundle_id
    (root / "data" / "timeseries").mkdir(parents=True, exist_ok=True)
    points = list(CORE)
    semantic_extras = [
        ("房间温度辅助", "房间温度"),
        ("冷冻水供水温度辅助", "冷冻水供水温度"),
        ("冷冻水回水温度辅助", "冷冻水回水温度"),
        ("IT功率辅助", "IT功率"),
    ]
    for index in range(len(CORE), point_count):
        name, description = semantic_extras[(index - len(CORE)) % len(semantic_extras)]
        unit = "℃" if "温度" in name else "kW"
        points.append((f"extra-{index:03d}", f"{name}{index:03d}", description, unit, "continuous", 60))
    catalog = pd.DataFrame(points, columns=["point_id", "name", "description", "unit", "variable_type", "expected_interval_seconds"])
    catalog.to_parquet(root / "points.parquet", index=False)

    start = pd.Timestamp("2025-06-01T00:00:00Z")
    minute_index = pd.date_range(start, periods=periods, freq="1min")
    rng = np.random.default_rng(20260729)
    frames: list[pd.DataFrame] = []
    for offset, row in catalog.iterrows():
        interval = int(row["expected_interval_seconds"])
        timestamps = minute_index[:: max(1, interval // 60)]
        phase = np.arange(len(timestamps))
        if row["variable_type"] == "continuous":
            if row["point_id"] == "target-load":
                values = 8000 + 400 * np.sin(phase / 20)
            elif row["point_id"] == "it-total":
                values = 7800 + 100 * np.sin(phase / 20)
            elif "temp" in row["point_id"] or "bulb" in row["point_id"] or "chw" in row["point_id"]:
                values = 20 + 2 * np.sin(phase / 20 + offset / 10)
            elif row["point_id"] == "chiller-power":
                values = 600 + 60 * np.sin(phase / 20)
            else:
                values = 100 + rng.normal(0, 3, len(timestamps))
        elif row["variable_type"] == "state":
            values = (phase % 3 != 0).astype(float)
        else:
            values = (phase % 4).astype(float)
        frame = pd.DataFrame({"timestamp": timestamps, "point_id": row["point_id"], "value_raw": values})
        frames.append(frame)
    data = pd.concat(frames, ignore_index=True)
    # Deterministic defects: absent timestamp, null, duplicate, invalid enum, negative reading.
    if periods > 30:
        data = data[~((data["point_id"] == "target-load") & (data["timestamp"] == minute_index[30]))]
    if periods > 40:
        data.loc[(data["point_id"] == "target-load") & (data["timestamp"] == minute_index[40]), "value_raw"] = np.nan
    if periods > 50:
        duplicate = data[(data["point_id"] == "target-load") & (data["timestamp"] == minute_index[50])].copy()
        data = pd.concat([data, duplicate], ignore_index=True)
    enum_rows = data.index[data["point_id"] == "free-cooling"]
    if len(enum_rows) > 2:
        data.loc[enum_rows[2], "value_raw"] = 30
    power_rows = data.index[data["point_id"] == "chiller-power"]
    if len(power_rows) > 3:
        data.loc[power_rows[3], "value_raw"] = -10
    data.to_parquet(root / "data" / "timeseries" / "part-000.parquet", index=False)
    fingerprint_payload = catalog[["point_id", "unit", "variable_type", "expected_interval_seconds"]].to_json(orient="records")
    fingerprint = hashlib.sha256(fingerprint_payload.encode()).hexdigest()
    manifest = {
        "bundle_type": "DatasetBundle",
        "bundle_version": "0.7",
        "dataset_bundle_id": bundle_id,
        "schema_fingerprint": fingerprint,
        "time_start": minute_index.min().isoformat(),
        "time_end": minute_index.max().isoformat(),
    }
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    (root / "parse_report.json").write_text(
        json.dumps(
            {
                "dataset_bundle_id": bundle_id,
                "state_encodings": {},
                "worksheets": [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return root


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--bundle-id", default="dq-fixture")
    parser.add_argument("--points", type=int, default=9)
    parser.add_argument("--periods", type=int, default=180)
    args = parser.parse_args()
    path = create_fixture(args.artifact_root, args.bundle_id, args.points, args.periods)
    print(json.dumps({"dataset_bundle": str(path), "point_count": args.points}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
