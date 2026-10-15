from __future__ import annotations

import hashlib
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def test_real_three_workflow_fixture_matches_the_recorded_snapshot() -> None:
    fixture = PROJECT / "test-data" / "e2e" / "three-workflows-v2.xlsx"
    assert fixture.stat().st_size == 2_951_705
    assert sha256(fixture) == "dfce4a69485f64cc8348fffa6c2e3f1a6a7fceca4e01e2dcad48b697b6ba9298"


def test_migrated_skill_sources_contain_no_environment_or_build_artifact() -> None:
    skills = PROJECT / ".agents" / "skills"
    forbidden_directories = {".venv", "build"}
    offenders = [
        path.relative_to(PROJECT).as_posix()
        for path in skills.rglob("*")
        if path.is_dir() and (path.name in forbidden_directories or path.name.endswith(".egg-info"))
    ]
    assert offenders == []
