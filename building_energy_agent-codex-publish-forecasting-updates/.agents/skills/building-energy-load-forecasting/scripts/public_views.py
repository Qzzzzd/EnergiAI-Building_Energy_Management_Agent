"""Small public views over native evaluation and forecast bundles."""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any


def _object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain a JSON object")
    return value


def _processing_context(artifact_root: Path, processing_bundle_id: str) -> dict[str, Any]:
    root = artifact_root / "processing-bundles" / processing_bundle_id
    manifest = _object(root / "manifest.json")
    target = _object(root / "target_metadata.json")
    report = _object(root / "processing_report.json") if (root / "processing_report.json").is_file() else {}
    split_manifest = _object(root / "split_manifest.json")
    context: dict[str, Any] = {"split_manifest": split_manifest}
    if "processing_mode" in manifest:
        context["mode"] = manifest["processing_mode"]
    if "target_point_id" in target:
        context["target_point_id"] = target["target_point_id"]
    if "target_unit" in target:
        context["unit"] = target["target_unit"]
    if "local_timezone" in report:
        context["timezone"] = report["local_timezone"]
    horizon_minutes = report.get("horizon_minutes")
    if isinstance(horizon_minutes, (int, float)) and not isinstance(horizon_minutes, bool):
        context["horizon_hours"] = horizon_minutes / 60
    return context


def evaluation_summary(bundle_root: Path, artifact_root: Path) -> dict[str, Any]:
    manifest = _object(bundle_root / "manifest.json")
    processing_bundle_id = manifest.get("processing_bundle_id")
    if not isinstance(processing_bundle_id, str):
        raise ValueError("EvaluationBundle does not identify its ProcessingBundle")
    context = _processing_context(artifact_root, processing_bundle_id)
    summary = {
        key: context[key]
        for key in ("mode", "target_point_id", "timezone", "horizon_hours")
        if key in context
    }
    splits = context.get("split_manifest", {}).get("splits", {})
    test = splits.get("test") if isinstance(splits, dict) else None
    if isinstance(test, dict):
        if "forecast_start" in test:
            summary["start_at"] = test["forecast_start"]
        if "forecast_end" in test:
            summary["end_at"] = test["forecast_end"]
    summary["metrics"] = _object(bundle_root / "metrics.json")
    return summary


def forecast_summary(bundle_root: Path, artifact_root: Path) -> dict[str, Any]:
    manifest = _object(bundle_root / "manifest.json")
    processing_bundle_id = manifest.get("processing_bundle_id")
    if not isinstance(processing_bundle_id, str):
        raise ValueError("ForecastBundle does not identify its ProcessingBundle")
    context = _processing_context(artifact_root, processing_bundle_id)
    summary = {
        key: context[key]
        for key in ("mode", "target_point_id", "timezone", "horizon_hours")
        if key in context
    }
    if "forecast_start" in manifest:
        summary["start_at"] = manifest["forecast_start"]
    if "forecast_end" in manifest:
        summary["end_at"] = manifest["forecast_end"]
    if "metrics" in manifest:
        summary["metrics"] = manifest["metrics"]
    if "summary" in manifest:
        summary["prediction_summary"] = manifest["summary"]
    return summary


def forecast_preview(bundle_root: Path, artifact_root: Path, *, limit: int = 200) -> list[dict[str, Any]]:
    if limit < 1 or limit > 200:
        raise ValueError("forecast preview limit must be between 1 and 200")
    manifest = _object(bundle_root / "manifest.json")
    processing_bundle_id = manifest.get("processing_bundle_id")
    if not isinstance(processing_bundle_id, str):
        raise ValueError("ForecastBundle does not identify its ProcessingBundle")
    unit = _processing_context(artifact_root, processing_bundle_id).get("unit")
    if not isinstance(unit, str) or not unit:
        raise ValueError("ForecastBundle target unit is unavailable")

    import pyarrow.parquet as parquet

    table = parquet.read_table(
        bundle_root / "predictions.parquet",
        columns=["target_timestamp", "prediction", "horizon_step"],
    ).slice(0, limit)
    preview: list[dict[str, Any]] = []
    for row in table.to_pylist():
        timestamp = row["target_timestamp"]
        prediction = row["prediction"]
        horizon_step = row["horizon_step"]
        if not isinstance(timestamp, datetime) or timestamp.tzinfo is None:
            raise ValueError("forecast preview timestamp is not timezone-aware")
        if not isinstance(prediction, (int, float)) or isinstance(prediction, bool) or not math.isfinite(prediction):
            raise ValueError("forecast preview prediction is not finite")
        if not isinstance(horizon_step, int) or isinstance(horizon_step, bool):
            raise ValueError("forecast preview horizon_step is invalid")
        preview.append(
            {
                "timestamp": timestamp.isoformat(),
                "prediction": float(prediction),
                "horizon_step": horizon_step,
                "unit": unit,
            }
        )
    return preview


__all__ = ["evaluation_summary", "forecast_preview", "forecast_summary"]
