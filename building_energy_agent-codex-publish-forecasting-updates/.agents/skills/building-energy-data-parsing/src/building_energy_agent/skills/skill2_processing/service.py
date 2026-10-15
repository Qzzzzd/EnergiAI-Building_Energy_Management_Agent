"""Synchronous local Skill 2 execution behind the V0.7 job boundary."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from building_energy_agent.contracts.skill2_v07 import (
    ProcessingSpec,
    Skill2ResultResponse,
    Skill2StartResponse,
    Skill2StatusResponse,
)
from building_energy_agent.core.errors import SkillNeedsInputError
from building_energy_agent.skills.skill2_processing.pipeline import (
    Skill2BacktestPipeline,
)


@dataclass(slots=True)
class _LocalJob:
    status: str
    current_stage: str
    progress: dict[str, int]
    warnings: list[str] = field(default_factory=list)
    result: Skill2ResultResponse | None = None
    error: str | None = None


class Skill2ProcessingService:
    """Run the approved target-history-v1 backtest pipeline locally."""

    def __init__(self, artifact_root: str | Path = ".skill-artifacts") -> None:
        self.pipeline = Skill2BacktestPipeline(artifact_root)
        self._jobs: dict[str, _LocalJob] = {}

    def start(self, request: ProcessingSpec) -> Skill2StartResponse:
        """Create a job record and synchronously build one ProcessingBundle."""

        request_json = request.model_dump_json()
        job_id = (
            f"processing-job-"
            f"{hashlib.sha256(request_json.encode()).hexdigest()[:20]}"
        )
        existing = self._jobs.get(job_id)
        if existing is not None:
            return Skill2StartResponse(job_id=job_id, status=existing.status)

        job = _LocalJob(
            status="running",
            current_stage="building_target_grid",
            progress={"completed": 0, "total": 1},
        )
        self._jobs[job_id] = job
        try:
            outcome = self.pipeline.run(request)
            job.result = Skill2ResultResponse(
                processing_bundle_id=outcome.bundle.processing_bundle_id,
                summary=outcome.summary,
            )
            job.status = "succeeded"
            job.current_stage = "completed"
            job.progress = {"completed": 1, "total": 1}
            job.warnings = list(outcome.warnings)
        except SkillNeedsInputError as exc:
            job.status = "needs_input"
            job.current_stage = "awaiting_input"
            job.warnings = [str(exc)]
            job.error = str(exc)
        except Exception as exc:
            job.status = "failed"
            job.current_stage = "failed"
            job.warnings = [str(exc)]
            job.error = str(exc)
        return Skill2StartResponse(job_id=job_id, status=job.status)

    def status(self, job_id: str) -> Skill2StatusResponse:
        """Inspect a local processing job."""

        job = self._job(job_id)
        return Skill2StatusResponse(
            status=job.status,
            progress=job.progress,
            current_stage=job.current_stage,
            warnings=job.warnings,
        )

    def result(self, job_id: str) -> Skill2ResultResponse:
        """Return a successful job's bundle ID and small summary."""

        job = self._job(job_id)
        if job.status != "succeeded" or job.result is None:
            raise RuntimeError(
                f"Skill 2 job {job_id!r} has no result "
                f"(status={job.status!r}): {job.error or 'not completed'}"
            )
        return job.result

    def _job(self, job_id: str) -> _LocalJob:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise KeyError(f"unknown Skill 2 job_id: {job_id}") from exc
