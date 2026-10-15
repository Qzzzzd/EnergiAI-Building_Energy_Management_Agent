#!/usr/bin/env python3
"""Run the real four-Skill topology against the repository acceptance fixture."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq


PREFIX = "BE_SKILL_EVENT "
TERMINAL = {"succeeded", "partial", "failed", "cancelled", "interrupted", "needs_input"}
SKILLS = {
    "parse": "building-energy-data-parsing",
    "process": "building-energy-data-processing",
    "quality": "building-energy-data-quality",
    "forecast": "building-energy-load-forecasting",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def event_lines(output: str) -> list[dict[str, Any]]:
    events = [
        json.loads(line.removeprefix(PREFIX))
        for line in output.splitlines()
        if line.startswith(PREFIX)
    ]
    if not events:
        raise RuntimeError(f"Skill command emitted no protocol event: {output[-2_000:]}")
    return events


class WorkflowRunner:
    def __init__(self, project: Path, workspace: Path) -> None:
        self.project = project
        self.workspace = workspace
        self.artifact_root = workspace / "artifacts"
        self.artifact_root.mkdir(parents=True)
        self._request_counter = 0
        self._request_lock = threading.Lock()

    def command(self, skill_key: str, *arguments: str, check: bool = True) -> list[dict[str, Any]]:
        skill = SKILLS[skill_key]
        python = self.project / ".runtime" / "skill-envs" / skill / "bin" / "python"
        skillctl = self.project / ".agents" / "skills" / skill / "scripts" / "skillctl"
        completed = subprocess.run(
            [str(python), str(skillctl), *arguments, "--workspace-root", str(self.workspace)],
            cwd=self.workspace,
            text=True,
            capture_output=True,
            timeout=1_800,
            check=False,
        )
        if check and completed.returncode != 0:
            raise RuntimeError(
                f"{skill} {' '.join(arguments)} failed ({completed.returncode}): "
                f"{completed.stdout[-4_000:]}\n{completed.stderr[-4_000:]}"
            )
        return event_lines(completed.stdout)

    def request_path(self, label: str, value: dict[str, Any]) -> Path:
        with self._request_lock:
            self._request_counter += 1
            path = self.workspace / f"request-{self._request_counter:02d}-{label}.json"
        json_write(path, value)
        return path

    def start(self, skill_key: str, label: str, request: dict[str, Any]) -> dict[str, Any]:
        request_path = self.request_path(label, request)
        started = self.command(
            skill_key,
            "start",
            "--request",
            request_path.name,
            "--session-id",
            "acceptance-session",
            "--turn-id",
            f"acceptance-{label}",
        )[-1]
        job_id = str(started["job_id"])
        state = self.wait(skill_key, job_id)
        return {"skill_key": skill_key, "job_id": job_id, "state": state}

    def wait(self, skill_key: str, job_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + 1_800
        while time.monotonic() < deadline:
            event = self.command(skill_key, "status", "--job-id", job_id)[-1]
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            status = str(payload.get("status") or event.get("outcome") or "")
            if status in TERMINAL:
                return {"status": status, "event": event}
            time.sleep(0.25)
        raise TimeoutError(f"{SKILLS[skill_key]} job {job_id} did not become terminal")

    def resume(self, run: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
        path = self.request_path(f"answers-{run['skill_key']}", answers)
        self.command(
            run["skill_key"],
            "resume",
            "--job-id",
            run["job_id"],
            "--answers",
            path.name,
        )
        run["state"] = self.wait(run["skill_key"], run["job_id"])
        return run

    def result(self, run: dict[str, Any]) -> dict[str, Any]:
        status = run["state"]["status"]
        if status not in {"succeeded", "partial"}:
            raise RuntimeError(f"{SKILLS[run['skill_key']]} ended as {status}: {run['state']}")
        events = self.command(run["skill_key"], "result", "--job-id", run["job_id"])
        payload = events[-1].get("payload")
        if not isinstance(payload, dict):
            raise RuntimeError("Skill result event omitted its result payload")
        return payload


def target_point(artifact_root: Path, dataset_bundle_id: str) -> str:
    rows = pq.read_table(
        artifact_root / "dataset-bundles" / dataset_bundle_id / "points.parquet",
        columns=["point_id", "name", "description"],
    ).to_pylist()
    candidates = []
    for row in rows:
        semantic_text = " ".join(
            str(row.get(key) or "") for key in ("point_id", "name", "description")
        )
        if "总冷机冷负荷" in semantic_text or "冷机制冷量" in semantic_text:
            candidates.append(str(row["point_id"]))
    if len(set(candidates)) != 1:
        raise RuntimeError(f"Acceptance target is not unique: {sorted(set(candidates))}")
    return candidates[0]


def validate_public_artifacts(artifact_root: Path, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    checked: list[dict[str, Any]] = []
    for result in results:
        for reference in result.get("artifact_refs", []):
            relative = Path(reference["manifest_relative_path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError(f"Unsafe Artifact manifest path: {relative}")
            manifest_path = artifact_root / relative
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for item in manifest["files"]:
                file_relative = Path(item["relative_path"])
                if file_relative.is_absolute() or ".." in file_relative.parts:
                    raise RuntimeError(f"Unsafe Artifact file path: {file_relative}")
                file_path = artifact_root / file_relative
                if file_path.stat().st_size != item["size_bytes"] or sha256(file_path) != item["sha256"]:
                    raise RuntimeError(f"Artifact integrity mismatch: {file_relative}")
            checked.append(
                {
                    "artifact_id": manifest["artifact_id"],
                    "artifact_type": manifest["artifact_type"],
                    "status": manifest["status"],
                    "manifest_sha256": sha256(manifest_path),
                    "file_count": len(manifest["files"]),
                    "roles": sorted(item["role"] for item in manifest["files"]),
                    "warnings": manifest["warnings"],
                }
            )
    return checked


def canonical_sha256(value: object) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def native_manifest(artifact_root: Path, collection: str, bundle_id: str) -> dict[str, Any]:
    path = artifact_root / collection / bundle_id / "manifest.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    normalized = dict(value)
    normalized.pop("created_at", None)
    volatile_files: set[str] = set()
    if collection == "model-bundles":
        normalized.pop("model_bundle_id", None)
        volatile_files = {"training_summary.json"}
    elif collection == "evaluation-bundles":
        normalized.pop("evaluation_bundle_id", None)
        normalized.pop("model_bundle_id", None)
        volatile_files = {"evaluation_report.md"}
    elif collection == "forecast-bundles":
        normalized.pop("forecast_bundle_id", None)
        normalized.pop("model_bundle_id", None)
        volatile_files = {"forecast_report.md"}
    hashes_key = "file_hashes" if isinstance(normalized.get("file_hashes"), dict) else "files"
    source_hashes = normalized.get(hashes_key, {})
    stable_hashes = {
        name: digest
        for name, digest in source_hashes.items()
        if name not in volatile_files
    }
    if hashes_key in normalized:
        normalized[hashes_key] = stable_hashes
    return {
        "bundle_id": bundle_id,
        "manifest_sha256": sha256(path),
        "stable_manifest_sha256": canonical_sha256(normalized),
        "stable_file_hashes": stable_hashes,
    }


def golden_projection(evidence: dict[str, Any]) -> dict[str, Any]:
    stable_native = {
        key: {
            "stable_manifest_sha256": value["stable_manifest_sha256"],
            "stable_file_hashes": value["stable_file_hashes"],
        }
        for key, value in evidence["native"].items()
    }
    return {
        "fixture": evidence["fixture"],
        "target_point_id": evidence["target_point_id"],
        "native": stable_native,
        "metrics": {
            "parse": evidence["results"]["parse"].get("summary", {}),
            "processing_backtest": evidence["results"]["processing_backtest"].get("summary", {}),
            "processing_future": evidence["results"]["processing_future"].get("summary", {}),
            "quality": evidence["results"]["quality"].get("summary", {}),
            "forecast_train": evidence["results"]["forecast_train"].get("summary", {}),
            "forecast_predict": evidence["results"]["forecast_predict"].get("summary", {}),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--candidate-only", action="store_true")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    fixture = (args.fixture or project / "test-data/e2e/three-workflows-v2.xlsx").resolve(strict=True)
    run_id = datetime.now(UTC).strftime("run-%Y%m%dT%H%M%SZ")
    run_root = project / ".runtime" / "acceptance" / "skill-workflows" / run_id
    workspace = run_root / "workspace"
    inputs = run_root / "inputs"
    workspace.mkdir(parents=True)
    inputs.mkdir(parents=True)
    snapshot = inputs / fixture.name
    shutil.copy2(fixture, snapshot)
    runner = WorkflowRunner(project, workspace)
    fixture_hash = sha256(snapshot)

    parsed_run = runner.start(
        "parse",
        "parse",
        {
            "sources": [
                {
                    "relative_path": f"../inputs/{snapshot.name}",
                    "source_ref": "src:three-workflows-v2",
                    "sha256": fixture_hash,
                }
            ],
            "parse_hints": {"source_timezone": "Asia/Shanghai"},
            "strict_mode": False,
        },
    )
    parsed = runner.result(parsed_run)
    dataset_id = str(parsed["dataset_bundle_id"])
    point_id = target_point(runner.artifact_root, dataset_id)

    processing_request = {
        "source_bundle_id": dataset_id,
        "target": {"point_id": point_id},
        "prediction_spec": {"forecast_horizon": "24h"},
        "feature_spec": {"preset": "default"},
        "data_scope": {"local_timezone": "Asia/Shanghai", "processing_mode": "backtest"},
        "split_spec": {"anchor_time": "00:00"},
    }
    quality_request = {
        "source_bundle_id": dataset_id,
        "assessment_context": {"task_type": "load_forecasting", "target_point_id": point_id},
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        processing_future = pool.submit(runner.start, "process", "processing-backtest", processing_request)
        quality_future = pool.submit(runner.start, "quality", "quality", quality_request)
        processing_run = processing_future.result()
        quality_run = quality_future.result()

    quality_resumed = False
    if quality_run["state"]["status"] == "needs_input":
        result_path = (
            workspace
            / ".be-skill-jobs"
            / SKILLS["quality"]
            / quality_run["job_id"]
            / "result.json"
        )
        candidate = json.loads(result_path.read_text(encoding="utf-8")).get("candidate_profile")
        if not isinstance(candidate, dict):
            raise RuntimeError("Quality Skill requested input without a candidate profile")
        runner.resume(quality_run, {"quality_profile": candidate})
        quality_resumed = True

    processing = runner.result(processing_run)
    quality = runner.result(quality_run)
    processing_id = str(processing["processing_bundle_id"])
    future_request = {
        **processing_request,
        "data_scope": {"local_timezone": "Asia/Shanghai", "processing_mode": "future"},
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        training_future = pool.submit(
            runner.start,
            "forecast",
            "forecast-train",
            {
                "processing_bundle_id": processing_id,
                "forecast_spec": {"mode": "backtest"},
                "resource_budget": {"threads": 1},
            },
        )
        future_processing_future = pool.submit(
            runner.start, "process", "processing-future", future_request
        )
        training_run = training_future.result()
        future_processing_run = future_processing_future.result()

    training = runner.result(training_run)
    future_processing = runner.result(future_processing_run)
    future_summary = future_processing.get("summary", {})
    prediction_run = runner.start(
        "forecast",
        "forecast-predict",
        {
            "model_bundle_id": training["model_bundle_id"],
            "processing_bundle_id": future_processing["processing_bundle_id"],
            "forecast_spec": {
                "mode": "future",
                "forecast_start": future_summary["forecast_start"],
                "forecast_end": future_summary["forecast_end"],
            },
            "resource_budget": {"threads": 1},
        },
    )
    prediction = runner.result(prediction_run)

    results = {
        "parse": parsed,
        "processing_backtest": processing,
        "quality": quality,
        "forecast_train": training,
        "processing_future": future_processing,
        "forecast_predict": prediction,
    }
    native = {
        "dataset": native_manifest(runner.artifact_root, "dataset-bundles", dataset_id),
        "processing_backtest": native_manifest(
            runner.artifact_root, "processing-bundles", processing_id
        ),
        "processing_future": native_manifest(
            runner.artifact_root,
            "processing-bundles",
            str(future_processing["processing_bundle_id"]),
        ),
        "quality": native_manifest(
            runner.artifact_root,
            "quality-assessment-bundles",
            str(quality["quality_assessment_bundle_id"]),
        ),
        "model": native_manifest(
            runner.artifact_root, "model-bundles", str(training["model_bundle_id"])
        ),
        "evaluation": native_manifest(
            runner.artifact_root,
            "evaluation-bundles",
            str(training["evaluation_bundle_id"]),
        ),
        "forecast": native_manifest(
            runner.artifact_root, "forecast-bundles", str(prediction["forecast_bundle_id"])
        ),
    }
    evidence = {
        "schema_version": "1.0",
        "generated_at": datetime.now(UTC).isoformat(),
        "run_root": str(run_root.relative_to(project)),
        "fixture": {"name": fixture.name, "size_bytes": snapshot.stat().st_size, "sha256": fixture_hash},
        "target_point_id": point_id,
        "quality_resume_used": quality_resumed,
        "topologies": {
            "forecast": ["Skill1", "Skill2(backtest)", "Skill4(train/evaluate)", "Skill2(future)", "Skill4(predict)"],
            "quality": ["Skill1", "Skill3"],
            "combined_parallel_groups": [
                ["Skill2(backtest)", "Skill3"],
                ["Skill4(train/evaluate)", "Skill2(future)"],
            ],
        },
        "results": results,
        "native": native,
        "public_artifacts": validate_public_artifacts(runner.artifact_root, list(results.values())),
    }
    evidence_path = run_root / "evidence.json"
    json_write(evidence_path, evidence)
    latest = project / ".runtime" / "acceptance" / "skill-workflows" / "latest.json"
    json_write(latest, evidence)

    projection = golden_projection(evidence)
    candidate_path = run_root / "golden-candidate.json"
    json_write(candidate_path, projection)
    golden_path = project / "test-data" / "golden" / "three-workflows-v2.skill-workflows.json"
    if golden_path.is_file() and not args.candidate_only:
        expected = json.loads(golden_path.read_text(encoding="utf-8"))
        if projection != expected:
            raise RuntimeError(
                f"Real Skill workflow drifted from {golden_path.relative_to(project)}; "
                f"inspect {candidate_path.relative_to(project)}"
            )
        evidence["golden_verified"] = True
        json_write(evidence_path, evidence)
        json_write(latest, evidence)
    else:
        evidence["golden_verified"] = False
        json_write(evidence_path, evidence)
        json_write(latest, evidence)

    print(json.dumps({
        "status": "passed",
        "evidence": str(evidence_path.relative_to(project)),
        "golden_candidate": str(candidate_path.relative_to(project)),
        "golden_verified": evidence["golden_verified"],
        "artifact_count": len(evidence["public_artifacts"]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
