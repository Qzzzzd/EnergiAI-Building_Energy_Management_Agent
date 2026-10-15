"""Small public views over native quality bundles."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def quality_summary(bundle_root: Path) -> dict[str, Any]:
    result = json.loads((bundle_root / "quality_result.json").read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise ValueError("quality_result.json must contain an object")
    summary: dict[str, Any] = {}
    if "conclusion" in result:
        summary["conclusion"] = result["conclusion"]
    if "overall_score" in result:
        summary["overall_score"] = result["overall_score"]

    dimensions = result.get("dimensions")
    if isinstance(dimensions, dict):
        public_dimensions: dict[str, dict[str, Any]] = {}
        for dimension_id, dimension in dimensions.items():
            if not isinstance(dimension_id, str) or not isinstance(dimension, dict):
                continue
            public_dimensions[dimension_id] = {
                "id": dimension_id,
                **{
                    key: dimension[key]
                    for key in ("status", "score", "summary")
                    if key in dimension
                },
            }
        summary["dimensions"] = public_dimensions

    issues = result.get("issues")
    if isinstance(issues, list):
        public_issues: list[dict[str, Any]] = []
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            public_issue = {
                key: issue[key]
                for key in ("severity", "dimension", "summary", "recommended_action")
                if key in issue
            }
            if "evidence" in issue:
                public_issue["evidence"] = issue["evidence"]
            elif "affected_scope" in issue:
                public_issue["evidence"] = issue["affected_scope"]
            public_issues.append(public_issue)
        summary["issues"] = public_issues

    if "recommendations" in result:
        summary["recommendations"] = result["recommendations"]
    if "effective_scope" in result:
        summary["effective_scope"] = result["effective_scope"]
    return summary


__all__ = ["quality_summary"]
