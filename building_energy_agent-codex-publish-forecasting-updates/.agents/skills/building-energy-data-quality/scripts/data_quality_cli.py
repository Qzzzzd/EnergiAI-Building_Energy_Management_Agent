#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from data_quality_assessment.errors import QualityError
from data_quality_assessment.jobs import (
    JobStore,
    default_artifact_root,
    result_for,
    resume_job,
    run_worker,
    start_job,
)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="V0.7 data quality assessment")
    sub = root.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start")
    start.add_argument("--spec", type=Path, required=True)
    status = sub.add_parser("status")
    status.add_argument("--job-id", required=True)
    resume = sub.add_parser("resume")
    resume.add_argument("--job-id", required=True)
    resume.add_argument("--profile", type=Path, required=True)
    result = sub.add_parser("result")
    result.add_argument("--job-id", required=True)
    worker = sub.add_parser("_worker")
    worker.add_argument("--job-id", required=True)
    for command in [start, status, resume, result, worker]:
        command.add_argument("--artifact-root", type=Path, default=default_artifact_root())
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "start":
            output = start_job(args.spec, args.artifact_root)
        elif args.command == "status":
            output = JobStore(args.artifact_root).read(args.job_id)
        elif args.command == "resume":
            output = resume_job(args.job_id, args.profile, args.artifact_root)
        elif args.command == "result":
            output = result_for(args.job_id, args.artifact_root)
        else:
            run_worker(args.job_id, args.artifact_root)
            return 0
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except QualityError as exc:
        print(json.dumps({"error": exc.as_dict()}, ensure_ascii=False, indent=2), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
