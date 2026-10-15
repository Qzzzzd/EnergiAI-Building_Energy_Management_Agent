from pathlib import Path

from building_energy_agent.cli import _parser


def test_parse_cli_defaults_to_shared_artifact_root() -> None:
    arguments = _parser().parse_args(["parse", "--source", "source.xlsx"])

    assert arguments.artifact_root == Path(".skill-artifacts")


def test_legacy_output_root_flag_uses_shared_root_semantics() -> None:
    arguments = _parser().parse_args(
        [
            "parse",
            "--source",
            "source.xlsx",
            "--output-root",
            "legacy-name",
        ]
    )

    assert arguments.artifact_root == Path("legacy-name")
