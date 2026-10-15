"""Synchronous local execution behind the V0.7 Skill 1 job boundary."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from building_energy_agent.contracts.skill1_v07 import (
    ParseRequest,
    Skill1ResultResponse,
    Skill1StartResponse,
    Skill1StatusResponse,
)
from building_energy_agent.core.artifact_store import dataset_bundles_root
from building_energy_agent.core.errors import SkillNeedsInputError
from building_energy_agent.skills.skill1_parse.parser import XlsxDatasetParser
from building_energy_agent.skills.skill1_parse.sources import LocalSourceRegistry


@dataclass(slots=True)
class _LocalJob:
    status: str
    current_stage: str
    progress: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    result: Skill1ResultResponse | None = None
    error: str | None = None


class Skill1ParseService:
    """Execute local parsing immediately while preserving start/status/result."""

    def __init__(
        self,
        source_registry: LocalSourceRegistry,
        artifact_root: str | Path,
    ) -> None:
        self.source_registry = source_registry
        self.parser = XlsxDatasetParser(dataset_bundles_root(artifact_root))
        self._jobs: dict[str, _LocalJob] = {}

    def start(self, request: ParseRequest) -> Skill1StartResponse:
        """Create a job record and synchronously execute the local parser."""

        request_json = request.model_dump_json()
        job_id = f"parse-job-{hashlib.sha256(request_json.encode()).hexdigest()[:20]}"
        job = _LocalJob(
            status="running",
            current_stage="resolving_sources",
            progress={"completed": 0, "total": len(request.sources)},
        )
        self._jobs[job_id] = job
        try:
            sources = [
                self.source_registry.resolve(source.source_ref)
                for source in request.sources
            ]
            source_timezone_value = request.parse_hints.get("source_timezone")
            if source_timezone_value is not None and not isinstance(
                source_timezone_value, str
            ):
                raise SkillNeedsInputError("source_timezone must be an IANA name")
            job.current_stage = "parsing"
            outcome = self.parser.parse(
                sources,
                source_timezone=source_timezone_value,
                strict_mode=request.strict_mode,
            )
            job.result = Skill1ResultResponse(
                dataset_bundle_id=outcome.dataset_bundle_id,
                summary=outcome.summary,
            )
            job.status = "succeeded"
            job.current_stage = "completed"
            job.progress = {
                "completed": len(sources),
                "total": len(sources),
            }
            job.warnings = outcome.summary.main_warnings
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
        return Skill1StartResponse(job_id=job_id, status=job.status)

    def status(self, job_id: str) -> Skill1StatusResponse:
        """Inspect a local parsing job."""

        job = self._job(job_id)
        return Skill1StatusResponse(
            status=job.status,
            progress=job.progress,
            current_stage=job.current_stage,
            warnings=job.warnings,
        )

    def result(self, job_id: str) -> Skill1ResultResponse:
        """Return a successful job's bundle ID and small summary."""

        job = self._job(job_id)
        if job.status != "succeeded" or job.result is None:
            raise RuntimeError(
                f"Skill 1 job {job_id!r} has no result (status={job.status!r}): "
                f"{job.error or 'not completed'}"
            )
        return job.result

    def _job(self, job_id: str) -> _LocalJob:
        try:
            return self._jobs[job_id]
        except KeyError as exc:
            raise KeyError(f"unknown Skill 1 job_id: {job_id}") from exc
