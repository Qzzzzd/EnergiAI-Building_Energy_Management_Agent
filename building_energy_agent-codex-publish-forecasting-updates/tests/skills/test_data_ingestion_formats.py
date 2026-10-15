from __future__ import annotations

import json
import hashlib
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pyarrow.parquet as pq
import pytest


PROJECT = Path(__file__).resolve().parents[2]
PARSING_SKILL = PROJECT / ".agents" / "skills" / "building-energy-data-parsing"
FORMATS = PROJECT / "test-data" / "formats"
sys.path.insert(0, str(PARSING_SKILL / "src"))

from building_energy_agent.core.errors import SkillNeedsInputError, SkillParseError
from building_energy_agent.skills.skill1_parse.format_parser import DeterministicDatasetParser
from building_energy_agent.skills.skill1_parse.sources import LocalSourceRegistry
from building_energy_agent.skills.skill1_parse.validation import validate_dataset_bundle


def parse_fixture(tmp_path: Path, name: str, timezone: str | None = "Asia/Shanghai"):
    registry = LocalSourceRegistry()
    source = registry.register(FORMATS / name)
    return DeterministicDatasetParser(tmp_path / "dataset-bundles").parse(
        [source], source_timezone=timezone, strict_mode=True
    )


@pytest.mark.parametrize(
    ("fixture", "expected_points", "expected_records"),
    [
        ("long.csv", {"total_load"}, 3),
        ("long-bom.csv", {"total_load"}, 3),
        ("wide.csv", {"total_load", "supply_temp"}, 6),
    ],
)
def test_csv_layouts_create_the_same_dataset_bundle_shape(
    tmp_path: Path, fixture: str, expected_points: set[str], expected_records: int
) -> None:
    outcome = parse_fixture(tmp_path, fixture)
    validation = validate_dataset_bundle(outcome.bundle_path)
    points = pq.read_table(outcome.bundle_path / "points.parquet").to_pylist()
    observations = pq.read_table(outcome.bundle_path / "data" / "timeseries")

    assert {point["point_id"] for point in points} == expected_points
    assert validation["record_count"] == expected_records
    assert observations.schema.field("timestamp").type.tz == "UTC"
    assert outcome.report_summary["source_timezone"] == "Asia/Shanghai"
    assert outcome.report_summary["null_count"] == 1


def test_naive_csv_time_requires_explicit_timezone(tmp_path: Path) -> None:
    with pytest.raises(SkillNeedsInputError, match="source_timezone"):
        parse_fixture(tmp_path, "long.csv", timezone=None)


def test_timezone_aware_csv_does_not_require_a_timezone_hint(tmp_path: Path) -> None:
    outcome = parse_fixture(tmp_path, "long-aware.csv", timezone=None)
    assert outcome.report_summary["source_timezone"] == "embedded"
    assert outcome.report_summary["time_start"] == "2025-12-31T16:00:00+00:00"


@pytest.mark.parametrize(
    ("fixture", "error"),
    [
        ("duplicate-header.csv", SkillParseError),
        ("ambiguous-time.csv", SkillNeedsInputError),
        ("invalid-encoding.csv", SkillParseError),
    ],
)
def test_csv_rejects_unsupported_or_ambiguous_shapes(
    tmp_path: Path, fixture: str, error: type[Exception]
) -> None:
    with pytest.raises(error):
        parse_fixture(tmp_path, fixture)


def test_xlsm_ignores_vba_and_reports_missing_formula_cache(tmp_path: Path) -> None:
    outcome = parse_fixture(tmp_path, "formula-no-cache.xlsm")
    report = json.loads((outcome.bundle_path / "parse_report.json").read_text(encoding="utf-8"))
    warnings = [warning for sheet in report["worksheets"] for warning in sheet["warnings"]]

    assert report["null_count"] == 3
    assert any("no cached value" in warning for warning in warnings)
    assert any("VBA content was ignored" in warning for warning in warnings)
    assert not any(path.name.casefold() == "vbaproject.bin" for path in outcome.bundle_path.rglob("*"))
    validate_dataset_bundle(outcome.bundle_path)


def _last_event(output: str) -> dict:
    prefix = "BE_SKILL_EVENT "
    return json.loads([line for line in output.splitlines() if line.startswith(prefix)][-1][len(prefix) :])


def test_real_parsing_adapter_resumes_timezone_question_with_same_job(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (tmp_path / "inputs").mkdir()
    source = tmp_path / "inputs" / "long.csv"
    shutil.copy2(FORMATS / "long.csv", source)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    (workspace / "request.json").write_text(
        json.dumps(
            {
                "sources": [
                    {
                        "relative_path": "../inputs/long.csv",
                        "source_ref": "src:test-upload",
                        "sha256": digest,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    skillctl = PARSING_SKILL / "scripts" / "skillctl"
    base = [sys.executable, str(skillctl)]
    started = subprocess.run(
        [
            *base,
            "start",
            "--request",
            "request.json",
            "--session-id",
            "session-test",
            "--turn-id",
            "turn-test",
            "--workspace-root",
            str(workspace),
        ],
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    job_id = _last_event(started.stdout)["job_id"]

    terminal = None
    for _ in range(100):
        checked = subprocess.run(
            [*base, "status", "--job-id", job_id, "--workspace-root", str(workspace)],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        terminal = _last_event(checked.stdout)
        if terminal["payload"]["status"] == "needs_input":
            break
        time.sleep(0.05)
    assert terminal is not None and terminal["payload"]["status"] == "needs_input"

    (workspace / "answers.json").write_text('{"source_timezone":"Asia/Shanghai"}\n', encoding="utf-8")
    resumed = subprocess.run(
        [
            *base,
            "resume",
            "--job-id",
            job_id,
            "--answers",
            "answers.json",
            "--workspace-root",
            str(workspace),
        ],
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    assert _last_event(resumed.stdout)["job_id"] == job_id
    for _ in range(100):
        checked = subprocess.run(
            [*base, "status", "--job-id", job_id, "--workspace-root", str(workspace)],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        terminal = _last_event(checked.stdout)
        if terminal["payload"]["status"] not in {"queued", "running"}:
            break
        time.sleep(0.05)
    assert terminal["payload"]["status"] == "succeeded"

    completed = subprocess.run(
        [*base, "result", "--job-id", job_id, "--workspace-root", str(workspace)],
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    emitted = [
        json.loads(line[len("BE_SKILL_EVENT ") :])
        for line in completed.stdout.splitlines()
        if line.startswith("BE_SKILL_EVENT ")
    ]
    artifact_event = next(item for item in emitted if item["kind"] == "artifact")
    completed_event = next(item for item in emitted if item["kind"] == "completed")
    assert artifact_event["manifest_relative_path"].startswith("public-artifacts/")
    assert not artifact_event["manifest_relative_path"].startswith("artifacts/")
    assert completed_event["outcome"] == "succeeded"
    assert completed_event["result_refs"][0]["artifact_id"] == artifact_event["artifact_id"]
    assert completed_event["result_refs"][0]["manifest_url"] == (
        "/api/v1/sessions/session-test/artifacts?turn_id=turn-test"
    )

    artifact_root = workspace / "artifacts"
    public_manifest = json.loads(
        (artifact_root / artifact_event["manifest_relative_path"]).read_text(encoding="utf-8")
    )
    assert public_manifest["schema_version"] == "1.0"
    assert public_manifest["source_ids"] == ["src:test-upload"]
    assert {item["role"] for item in public_manifest["files"]} >= {
        "summary",
        "native-manifest",
        "report",
        "visualization",
    }
    for public_file in public_manifest["files"]:
        path = artifact_root / public_file["relative_path"]
        assert path.is_file()
        assert path.stat().st_size == public_file["size_bytes"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == public_file["sha256"]
        assert path.suffix != ".parquet"
