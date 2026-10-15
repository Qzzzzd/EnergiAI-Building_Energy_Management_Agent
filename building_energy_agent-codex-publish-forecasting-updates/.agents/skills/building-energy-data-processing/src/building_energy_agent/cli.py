"""Local command line entry points for bundle parsing and inspection."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from building_energy_agent.contracts.skill1_v07 import ParseRequest, SourceReference
from building_energy_agent.contracts.skill2_v07 import (
    FeatureSpec,
    PredictionSpec,
    ProcessingSpec,
    TargetSpec,
)
from building_energy_agent.core.artifact_store import dataset_bundle_root
from building_energy_agent.skills.skill1_parse.service import Skill1ParseService
from building_energy_agent.skills.skill1_parse.sources import LocalSourceRegistry
from building_energy_agent.skills.skill1_parse.validation import validate_dataset_bundle
from building_energy_agent.skills.skill2_processing.preflight import (
    run_skill2_preflight,
)
from building_energy_agent.skills.skill2_processing.samples import (
    run_skill2_sample_plan,
)
from building_energy_agent.skills.skill2_processing.service import (
    Skill2ProcessingService,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="building-energy-agent")
    subparsers = parser.add_subparsers(dest="command", required=True)

    parse_command = subparsers.add_parser(
        "parse", help="parse a local XLSX source into a DatasetBundle"
    )
    parse_command.add_argument("--source", required=True, type=Path)
    parse_command.add_argument("--source-timezone")
    parse_command.add_argument(
        "--artifact-root",
        "--output-root",
        dest="artifact_root",
        type=Path,
        default=Path(".skill-artifacts"),
        help="shared Artifact Store root; --output-root is a compatibility alias",
    )
    parse_command.add_argument("--strict", action="store_true")

    validate_command = subparsers.add_parser(
        "validate", help="validate an existing DatasetBundle"
    )
    validate_command.add_argument("--bundle", required=True, type=Path)

    preflight_command = subparsers.add_parser(
        "skill2-preflight",
        help="inspect the Skill 2 target input without modifying it",
    )
    preflight_command.add_argument("--bundle", required=True, type=Path)

    sample_plan_command = subparsers.add_parser(
        "skill2-sample-plan",
        help="summarize the internal Skill 2 target grid and SamplePlan",
    )
    sample_plan_command.add_argument("--bundle", required=True, type=Path)
    sample_plan_command.add_argument("--local-timezone", default="Asia/Shanghai")
    sample_plan_command.add_argument("--anchor-time", default="00:00")
    sample_plan_command.add_argument("--forecast-horizon", default="24h")

    build_command = subparsers.add_parser(
        "skill2-build-backtest",
        help="build a building-energy-history-v2 backtest ProcessingBundle",
    )
    build_command.add_argument("--source-bundle-id", required=True)
    build_command.add_argument("--target-point-id", required=True)
    build_command.add_argument(
        "--artifact-root",
        type=Path,
        default=Path(".skill-artifacts"),
    )
    build_command.add_argument("--local-timezone", default="Asia/Shanghai")
    build_command.add_argument("--anchor-time", default="00:00")
    build_command.add_argument("--forecast-horizon", default="24h")
    build_command.add_argument(
        "--feature-preset",
        default="building-energy-history-v2",
    )
    return parser


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _parse_command(arguments: argparse.Namespace) -> int:
    registry = LocalSourceRegistry()
    source = registry.register(arguments.source)
    service = Skill1ParseService(registry, arguments.artifact_root)
    parse_hints: dict[str, Any] = {}
    if arguments.source_timezone is not None:
        parse_hints["source_timezone"] = arguments.source_timezone
    request = ParseRequest(
        sources=[SourceReference(source_ref=source.source_ref)],
        parse_hints=parse_hints,
        strict_mode=arguments.strict,
    )
    started = service.start(request)
    status = service.status(started.job_id)
    if status.status != "succeeded":
        _print_json(
            {
                "job_id": started.job_id,
                "status": status.status,
                "current_stage": status.current_stage,
                "warnings": status.warnings,
            }
        )
        return 2 if status.status == "needs_input" else 1

    result = service.result(started.job_id)
    bundle_path = dataset_bundle_root(
        arguments.artifact_root,
        result.dataset_bundle_id,
    )
    validation = validate_dataset_bundle(bundle_path)
    _print_json(
        {
            "job_id": started.job_id,
            "status": status.status,
            "dataset_bundle_id": result.dataset_bundle_id,
            "bundle_path": str(bundle_path),
            "summary": result.summary.model_dump(mode="json"),
            "validation": validation,
        }
    )
    return 0


def _skill2_preflight_command(arguments: argparse.Namespace) -> int:
    try:
        profile = run_skill2_preflight(arguments.bundle)
    except Exception as exc:
        _print_json(
            {
                "status": "failed",
                "error": str(exc),
            }
        )
        return 1
    payload = profile.model_dump(mode="json")
    payload["status"] = "needs_input" if profile.needs_input else "succeeded"
    _print_json(payload)
    return 2 if profile.needs_input else 0


def _skill2_sample_plan_command(arguments: argparse.Namespace) -> int:
    try:
        payload = run_skill2_sample_plan(
            bundle_path=arguments.bundle,
            local_timezone=arguments.local_timezone,
            anchor_time=arguments.anchor_time,
            forecast_horizon=arguments.forecast_horizon,
        )
    except Exception as exc:
        _print_json({"status": "failed", "error": str(exc)})
        return 1
    payload["status"] = "needs_input" if payload["needs_input"] else "succeeded"
    _print_json(payload)
    return 2 if payload["needs_input"] else 0


def _skill2_build_backtest_command(arguments: argparse.Namespace) -> int:
    service = Skill2ProcessingService(arguments.artifact_root)
    request = ProcessingSpec(
        source_bundle_id=arguments.source_bundle_id,
        target=TargetSpec(point_id=arguments.target_point_id),
        prediction_spec=PredictionSpec(
            forecast_horizon=arguments.forecast_horizon
        ),
        feature_spec=FeatureSpec(preset=arguments.feature_preset),
        data_scope={"local_timezone": arguments.local_timezone},
        split_spec={"anchor_time": arguments.anchor_time},
    )
    started = service.start(request)
    status = service.status(started.job_id)
    if status.status != "succeeded":
        _print_json(
            {
                "job_id": started.job_id,
                "status": status.status,
                "current_stage": status.current_stage,
                "warnings": status.warnings,
            }
        )
        return 2 if status.status == "needs_input" else 1
    result = service.result(started.job_id)
    _print_json(
        {
            "job_id": started.job_id,
            "status": status.status,
            "processing_bundle_id": result.processing_bundle_id,
            "summary": result.summary,
            "warnings": status.warnings,
        }
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.command == "parse":
        return _parse_command(arguments)
    if arguments.command == "validate":
        _print_json(validate_dataset_bundle(arguments.bundle))
        return 0
    if arguments.command == "skill2-preflight":
        return _skill2_preflight_command(arguments)
    if arguments.command == "skill2-sample-plan":
        return _skill2_sample_plan_command(arguments)
    if arguments.command == "skill2-build-backtest":
        return _skill2_build_backtest_command(arguments)
    raise AssertionError(f"unhandled command: {arguments.command}")


if __name__ == "__main__":
    raise SystemExit(main())
