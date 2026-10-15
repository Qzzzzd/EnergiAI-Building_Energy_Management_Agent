#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from load_forecasting.errors import ForecastError
from load_forecasting.jobs import get_result, get_status, run_job, start_job


def default_artifact_root() -> Path:
    return Path(__file__).resolve().parents[3] / ".skill-artifacts"


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="V0.7 building-load forecasting")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("start-train-evaluate", "start-predict"):
        command = commands.add_parser(name)
        command.add_argument("--request", required=True, type=Path)
        command.add_argument("--artifact-root", type=Path, default=default_artifact_root())
    for name in ("status", "result", "_run-job"):
        command = commands.add_parser(name)
        command.add_argument("--job-id", required=True)
        command.add_argument("--artifact-root", type=Path, default=default_artifact_root())
    return root


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False))


def main() -> int:
    args = parser().parse_args()
    artifact_root = args.artifact_root.resolve()
    try:
        if args.command.startswith("start-"):
            with args.request.open(encoding="utf-8") as handle:
                request = json.load(handle)
            action = "train_evaluate" if args.command == "start-train-evaluate" else "predict"
            emit(start_job(action, request, artifact_root, Path(__file__).resolve()))
        elif args.command == "status":
            emit(get_status(artifact_root, args.job_id))
        elif args.command == "result":
            emit(get_result(artifact_root, args.job_id))
        else:
            run_job(artifact_root, args.job_id)
        return 0
    except ForecastError as exc:
        emit({"status": "failed", "error": exc.as_dict()})
        return 2
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        emit({"status": "failed", "error": {"code": "INVALID_REQUEST", "message": str(exc), "details": {}}})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
