from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest
from openpyxl import Workbook

from building_energy_agent.contracts.skill1_v07 import ParseRequest, SourceReference
from building_energy_agent.skills.skill1_parse.service import Skill1ParseService
from building_energy_agent.skills.skill1_parse.sources import LocalSourceRegistry


SKILLS_ROOT = Path(__file__).resolve().parents[3]
SKILL3_SCRIPTS = SKILLS_ROOT / "building-energy-data-quality" / "scripts"
sys.path.insert(0, str(SKILL3_SCRIPTS))

from data_quality_assessment.bundle import load_dataset_bundle  # noqa: E402


def _write_minimal_workbook(path: Path) -> None:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "chiller-load"
    sheet.append(["time", "P-LOAD"])
    sheet.append(["description", "chiller-system|total-chiller-load|kW"])
    sheet.append([datetime(2026, 1, 1, 8, 0), 10.0])
    sheet.append([datetime(2026, 1, 1, 8, 1), 11.0])
    sheet.append([datetime(2026, 1, 1, 8, 2), 12.0])
    workbook.save(path)


@pytest.mark.integration
def test_skill3_loads_dataset_bundle_written_by_skill1(tmp_path: Path) -> None:
    source_path = tmp_path / "skill1-source.xlsx"
    _write_minimal_workbook(source_path)

    artifact_root = tmp_path / "shared-artifacts"
    registry = LocalSourceRegistry()
    source = registry.register(source_path)
    service = Skill1ParseService(registry, artifact_root)

    started = service.start(
        ParseRequest(
            sources=[SourceReference(source_ref=source.source_ref)],
            parse_hints={"source_timezone": "Asia/Shanghai"},
        )
    )

    assert started.status == "succeeded"
    result = service.result(started.job_id)
    bundle = load_dataset_bundle(artifact_root, result.dataset_bundle_id)

    assert bundle.root == (
        artifact_root / "dataset-bundles" / result.dataset_bundle_id
    ).resolve()
    assert bundle.manifest.dataset_bundle_id == result.dataset_bundle_id
    assert bundle.points["point_id"].astype(str).tolist() == ["P-LOAD"]

    observations = bundle.load_points(["P-LOAD"])
    assert observations["point_id"].tolist() == ["P-LOAD"] * 3
    assert observations["value_raw"].tolist() == [10.0, 11.0, 12.0]
    assert observations["timestamp"].dt.tz is not None
    assert observations["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%SZ").tolist() == [
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:01:00Z",
        "2026-01-01T00:02:00Z",
    ]
