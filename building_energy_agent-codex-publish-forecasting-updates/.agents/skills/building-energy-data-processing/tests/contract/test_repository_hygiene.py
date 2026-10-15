from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _effective_lines(filename: str) -> set[str]:
    return {
        line.strip()
        for line in (REPOSITORY_ROOT / filename).read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }


def test_real_data_and_artifacts_are_excluded_from_git_and_build_context() -> None:
    ignored = {"data/", "artifacts/", ".skill-artifacts/", ".venv/", ".env"}
    assert ignored.issubset(
        _effective_lines(".gitignore")
    )
    assert ignored.issubset(
        _effective_lines(".dockerignore")
    )

    dockerfile = (REPOSITORY_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "COPY data" not in dockerfile
    assert "ADD data" not in dockerfile
