"""Deterministic V0.7 bundle schema fingerprint algorithms."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any


def _canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def dataset_schema_fingerprint(points: Iterable[Mapping[str, Any]]) -> str:
    """Hash the frozen quality-relevant point fields in point-id order."""

    normalized = [
        {
            "point_id": point["point_id"],
            "unit": point.get("unit"),
            "variable_type": point["variable_type"],
            "expected_interval_seconds": point["expected_interval_seconds"],
        }
        for point in points
    ]
    normalized.sort(key=lambda point: point["point_id"])
    return _canonical_sha256(normalized)


def feature_schema_fingerprint(entries: Iterable[Mapping[str, Any]]) -> str:
    """Hash feature catalog rows in their model-feature order."""

    normalized = [
        {
            "feature_name": entry.get("feature_name") or "",
            "data_type": entry.get("data_type") or "",
            "source_point_id": entry.get("source_point_id") or "",
            "semantic_version": entry.get("semantic_version") or "",
        }
        for entry in entries
    ]
    return _canonical_sha256(normalized)
