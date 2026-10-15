from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from .errors import ForecastError
from .modeling import predict, train_evaluate
from .util import atomic_json, read_json, safe_child, utc_now

TERMINAL = {"succeeded", "failed"}


def jobs_root(artifact_root: Path) -> Path:
    return safe_child(artifact_root, "jobs")


def job_dir(artifact_root: Path, job_id: str) -> Path:
    if not job_id.startswith("job-") or "/" in job_id or "\\" in job_id:
        raise ForecastError("JOB_NOT_FOUND", "Invalid job ID.")
    return safe_child(jobs_root(artifact_root), job_id)


def start_job(
    action: str,
    request: dict[str, Any],
    artifact_root: Path,
    cli_path: Path,
    *,
    launch_worker: bool = True,
) -> dict[str, Any]:
    if action not in {"train_evaluate", "predict"}:
        raise ValueError(action)
    job_id = f"job-{uuid.uuid4().hex}"
    root = job_dir(artifact_root, job_id)
    root.mkdir(parents=True, exist_ok=False)
    atomic_json(root / "request.json", request)
    atomic_json(
        root / "status.json",
        {
            "job_id": job_id,
            "action": action,
            "status": "queued",
            "progress": 0,
            "current_stage": "queued",
            "warnings": [],
            "created_at": utc_now(),
            "updated_at": utc_now(),
        },
    )
    if not launch_worker:
        return {"job_id": job_id, "status": "queued"}
    log = (root / "job.log").open("ab", buffering=0)
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                str(cli_path),
                "_run-job",
                "--job-id",
                job_id,
                "--artifact-root",
                str(artifact_root),
            ],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        log.close()
    current = read_json(root / "status.json")
    current["worker_pid"] = process.pid
    current["updated_at"] = utc_now()
    atomic_json(root / "status.json", current)
    return {"job_id": job_id, "status": "queued"}


def get_status(artifact_root: Path, job_id: str) -> dict[str, Any]:
    path = job_dir(artifact_root, job_id) / "status.json"
    if not path.is_file():
        raise ForecastError("JOB_NOT_FOUND", "Job does not exist.", {"job_id": job_id})
    return read_json(path)


def get_result(artifact_root: Path, job_id: str) -> dict[str, Any]:
    status = get_status(artifact_root, job_id)
    if status["status"] not in TERMINAL:
        return {"job_id": job_id, "status": status["status"], "result_ready": False}
    path = job_dir(artifact_root, job_id) / "result.json"
    if not path.is_file():
        raise ForecastError("MODEL_ARTIFACT_INVALID", "Terminal job has no result record.", {"job_id": job_id})
    return read_json(path)


def run_job(artifact_root: Path, job_id: str) -> None:
    root = job_dir(artifact_root, job_id)
    status = get_status(artifact_root, job_id)
    request = read_json(root / "request.json")

    def update(stage: str, progress: int) -> None:
        current = read_json(root / "status.json")
        current.update(
            {
                "status": "running",
                "current_stage": stage,
                "progress": progress,
                "updated_at": utc_now(),
            }
        )
        atomic_json(root / "status.json", current)

    update("starting", 1)
    try:
        if status["action"] == "train_evaluate":
            payload = train_evaluate(request, artifact_root, update)
        elif status["action"] == "predict":
            payload = predict(request, artifact_root, update)
        else:
            raise ValueError(f"unknown job action {status['action']}")
        result = {"job_id": job_id, "status": "succeeded", **payload}
        atomic_json(root / "result.json", result)
        final = read_json(root / "status.json")
        final.update(
            {
                "status": "succeeded",
                "current_stage": "completed",
                "progress": 100,
                "warnings": payload.get("warnings", []),
                "updated_at": utc_now(),
            }
        )
        atomic_json(root / "status.json", final)
    except ForecastError as exc:
        result = {"job_id": job_id, "status": "failed", "error": exc.as_dict()}
        atomic_json(root / "result.json", result)
        final = read_json(root / "status.json")
        final.update(
            {
                "status": "failed",
                "current_stage": "failed",
                "error": exc.as_dict(),
                "updated_at": utc_now(),
            }
        )
        atomic_json(root / "status.json", final)
    except Exception as exc:
        error = ForecastError("INTERNAL_ERROR", "Unexpected Skill 4 failure.", {"type": type(exc).__name__, "message": str(exc)})
        atomic_json(root / "result.json", {"job_id": job_id, "status": "failed", "error": error.as_dict()})
        final = read_json(root / "status.json")
        final.update({"status": "failed", "current_stage": "failed", "error": error.as_dict(), "updated_at": utc_now()})
        atomic_json(root / "status.json", final)
        raise
