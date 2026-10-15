from __future__ import annotations

import json
import importlib.machinery
import importlib.util
import os
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
COMMON_SKILLCTL = PROJECT / ".agents" / "skills" / "building-energy-data-parsing" / "scripts" / "skillctl"
PREFIX = "BE_SKILL_EVENT "


ADAPTER = '''
import time

def execute(*, request, answers, job_dir, workspace_root, artifact_root, progress):
    if request.get("mode") == "artifact":
        progress("building_artifact", 1, 2, [])
        time.sleep(0.2)
        return {
            "status": "succeeded",
            "artifact_refs": [{
                "artifact_id": "artifact-test",
                "artifact_type": "test.result",
                "status": "succeeded",
                "manifest_relative_path": "public-artifacts/artifact-test/manifest.json",
            }],
            "warnings": [],
        }
    if request.get("mode") == "sleep":
        for index in range(200):
            progress("sleeping", index, 200, [])
            time.sleep(0.05)
        return {"status": "succeeded", "artifact_refs": [], "warnings": []}
    if answers is None:
        return {
            "status": "needs_input",
            "required_inputs": [{"id": "timezone", "question": "Timezone?", "options": ["UTC"], "allow_free_text": True, "required": True}],
            "warnings": [],
        }
    return {"status": "succeeded", "answer": answers["timezone"], "artifact_refs": [], "warnings": []}
'''


def event(output: str) -> dict:
    lines = [line for line in output.splitlines() if line.startswith(PREFIX)]
    assert lines, output
    return json.loads(lines[-1][len(PREFIX) :])


def run(skillctl: Path, workspace: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    command_arguments = list(arguments)
    if command_arguments and command_arguments[0] == "start":
        command_arguments.extend(["--session-id", "session-test", "--turn-id", "turn-test"])
    return subprocess.run(
        [sys.executable, str(skillctl), *command_arguments, "--workspace-root", str(workspace)],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )


def wait_for_state(skillctl: Path, workspace: Path, job_id: str, wanted: set[str]) -> dict:
    deadline = time.monotonic() + 10
    latest = {}
    while time.monotonic() < deadline:
        checked = run(skillctl, workspace, "status", "--job-id", job_id)
        latest = event(checked.stdout)
        state = latest["payload"]["status"]
        if state in wanted:
            return latest
        time.sleep(0.05)
    raise AssertionError(f"job did not reach {wanted}: {latest}")


def make_test_skill(tmp_path: Path) -> tuple[Path, Path]:
    workspace = tmp_path / "workspace"
    scripts = tmp_path / "test-compute-skill" / "scripts"
    workspace.mkdir()
    scripts.mkdir(parents=True)
    skillctl = scripts / "skillctl"
    shutil.copy2(COMMON_SKILLCTL, skillctl)
    (scripts / "skill_adapter.py").write_text(ADAPTER, encoding="utf-8")
    return workspace, skillctl


def load_skillctl():
    loader = importlib.machinery.SourceFileLoader("test_skillctl_module", str(COMMON_SKILLCTL))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def assert_skill_events_match_contract(events: list[dict]) -> None:
    script = """
import { readFileSync } from 'node:fs';
import { SkillEventSchema } from './packages/contracts/src/index.ts';
for (const event of JSON.parse(readFileSync(0, 'utf8'))) SkillEventSchema.parse(event);
"""
    checked = subprocess.run(
        [str(PROJECT / "node_modules" / ".bin" / "tsx"), "--eval", script],
        cwd=PROJECT,
        input=json.dumps(events),
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_needs_input_resumes_same_persisted_job(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text("{}\n", encoding="utf-8")
    started = run(skillctl, workspace, "start", "--request", "request.json")
    started_event = event(started.stdout)
    job_id = started_event["job_id"]
    assert started_event["payload"]["session_id"] == "session-test"
    assert started_event["payload"]["turn_id"] == "turn-test"
    persisted = json.loads(
        (
            workspace
            / ".be-skill-jobs"
            / "test-compute-skill"
            / job_id
            / "status.json"
        ).read_text(encoding="utf-8")
    )
    assert persisted["session_id"] == "session-test"
    assert persisted["turn_id"] == "turn-test"
    waiting = wait_for_state(skillctl, workspace, job_id, {"needs_input"})
    assert waiting["kind"] == "needs_input"

    (workspace / "answers.json").write_text('{"timezone":"UTC"}\n', encoding="utf-8")
    resumed = run(skillctl, workspace, "resume", "--job-id", job_id, "--answers", "answers.json")
    assert event(resumed.stdout)["job_id"] == job_id
    wait_for_state(skillctl, workspace, job_id, {"succeeded"})
    result = run(skillctl, workspace, "result", "--job-id", job_id)
    payload = event(result.stdout)["payload"]
    assert payload["job_id"] == job_id
    assert payload["answer"] == "UTC"


def test_foreground_mode_runs_and_resumes_without_a_detached_worker(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text("{}\n", encoding="utf-8")
    environment = {**os.environ, "BE_SKILL_FOREGROUND": "1"}
    started = subprocess.run(
        [
            sys.executable,
            str(skillctl),
            "start",
            "--request",
            "request.json",
            "--session-id",
            "session-test",
            "--turn-id",
            "turn-test",
            "--workspace-root",
            str(workspace),
        ],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
        env=environment,
    )
    started_events = [
        json.loads(line[len(PREFIX) :])
        for line in started.stdout.splitlines()
        if line.startswith(PREFIX)
    ]
    assert started.returncode == 0
    assert [item["kind"] for item in started_events] == ["started", "progress", "needs_input"]
    job_id = started_events[-1]["job_id"]
    status_path = workspace / ".be-skill-jobs" / "test-compute-skill" / job_id / "status.json"
    assert "worker_pid" not in json.loads(status_path.read_text(encoding="utf-8"))

    (workspace / "answers.json").write_text('{"timezone":"UTC"}\n', encoding="utf-8")
    resumed = subprocess.run(
        [
            sys.executable,
            str(skillctl),
            "resume",
            "--job-id",
            job_id,
            "--answers",
            "answers.json",
            "--workspace-root",
            str(workspace),
        ],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
        env=environment,
    )
    assert resumed.returncode == 0
    assert event(resumed.stdout)["outcome"] == "succeeded"
    assert json.loads(status_path.read_text(encoding="utf-8"))["status"] == "succeeded"


def test_cancel_stops_the_real_worker_process_group(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text('{"mode":"sleep"}\n', encoding="utf-8")
    started = run(skillctl, workspace, "start", "--request", "request.json")
    job_id = event(started.stdout)["job_id"]
    wait_for_state(skillctl, workspace, job_id, {"running"})
    status_path = workspace / ".be-skill-jobs" / "test-compute-skill" / job_id / "status.json"
    worker_pid = json.loads(status_path.read_text(encoding="utf-8"))["worker_pid"]

    cancelled = run(skillctl, workspace, "cancel", "--job-id", job_id, "--grace-seconds", "1")
    cancelled_event = event(cancelled.stdout)
    assert cancelled.returncode == 0
    assert cancelled_event["kind"] == "cancelled"
    assert cancelled_event["payload"]["status"] == "cancelled"
    assert not Path(f"/proc/{worker_pid}").exists()


def test_status_marks_a_persisted_job_interrupted_after_its_worker_dies(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text('{"mode":"sleep"}\n', encoding="utf-8")
    started = run(skillctl, workspace, "start", "--request", "request.json")
    job_id = event(started.stdout)["job_id"]
    wait_for_state(skillctl, workspace, job_id, {"running"})
    status_path = workspace / ".be-skill-jobs" / "test-compute-skill" / job_id / "status.json"
    worker_pid = json.loads(status_path.read_text(encoding="utf-8"))["worker_pid"]
    os.killpg(worker_pid, signal.SIGKILL)
    deadline = time.monotonic() + 5
    while Path(f"/proc/{worker_pid}").exists() and time.monotonic() < deadline:
        time.sleep(0.02)

    checked = run(skillctl, workspace, "status", "--job-id", job_id)
    interrupted = event(checked.stdout)
    persisted = json.loads(status_path.read_text(encoding="utf-8"))
    assert interrupted["kind"] == "failed"
    assert interrupted["error"]["code"] == "TURN_INTERRUPTED"
    assert interrupted["payload"]["status"] == "interrupted"
    assert persisted["status"] == "interrupted"


def test_start_requires_session_and_turn_context(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text("{}\n", encoding="utf-8")
    rejected = subprocess.run(
        [
            sys.executable,
            str(skillctl),
            "start",
            "--request",
            "request.json",
            "--workspace-root",
            str(workspace),
        ],
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert rejected.returncode == 2
    assert "--session-id" in rejected.stderr
    assert "--turn-id" in rejected.stderr


def test_status_then_result_sequence_is_contract_valid_and_idempotent(tmp_path: Path) -> None:
    workspace, skillctl = make_test_skill(tmp_path)
    (workspace / "request.json").write_text('{"mode":"artifact"}\n', encoding="utf-8")
    started = run(skillctl, workspace, "start", "--request", "request.json")
    started_event = event(started.stdout)
    job_id = started_event["job_id"]

    progress_event = wait_for_state(skillctl, workspace, job_id, {"running"})
    completed_status = wait_for_state(skillctl, workspace, job_id, {"succeeded"})
    first_result = run(skillctl, workspace, "result", "--job-id", job_id)
    second_result = run(skillctl, workspace, "result", "--job-id", job_id)
    first_events = [
        json.loads(line[len(PREFIX) :])
        for line in first_result.stdout.splitlines()
        if line.startswith(PREFIX)
    ]
    second_events = [
        json.loads(line[len(PREFIX) :])
        for line in second_result.stdout.splitlines()
        if line.startswith(PREFIX)
    ]

    assert [item["kind"] for item in first_events] == ["artifact", "completed"]
    assert completed_status["event_id"] == first_events[-1]["event_id"]
    assert [item["event_id"] for item in first_events] == [item["event_id"] for item in second_events]
    assert_skill_events_match_contract(
        [started_event, progress_event, completed_status, *first_events]
    )


def test_all_migrated_skills_use_the_same_lifecycle_implementation() -> None:
    expected = COMMON_SKILLCTL.read_bytes()
    for skill in (
        "building-energy-data-processing",
        "building-energy-data-quality",
        "building-energy-load-forecasting",
    ):
        actual = PROJECT / ".agents" / "skills" / skill / "scripts" / "skillctl"
        assert actual.read_bytes() == expected


def test_every_event_kind_uses_only_its_strict_contract_fields() -> None:
    skillctl = load_skillctl()
    common = {
        "skill_name": "test-compute-skill",
        "job_id": "job-" + "1" * 32,
        "session_id": "session-1",
        "turn_id": "turn-1",
        "stage": "testing",
        "progress": {"completed": 1, "total": 2, "unit": "stage"},
        "warnings": [],
    }
    artifact = {
        "artifact_id": "artifact-1",
        "artifact_type": "ForecastBundle",
        "status": "partial",
        "manifest_relative_path": "public-artifacts/artifact-1/manifest.json",
    }
    questions = [
        {
            "id": "timezone",
            "question": "Timezone?",
            "options": ["UTC"],
            "allow_free_text": True,
            "required": True,
        }
    ]
    events = [
        skillctl._event({**common, "status": "queued"}, "started"),
        skillctl._event({**common, "status": "running"}, "progress"),
        skillctl._event({**common, "status": "needs_input", "required_inputs": questions}, "needs_input"),
        skillctl._event({**common, "status": "running"}, "artifact", {"artifact": artifact}),
        skillctl._event({**common, "status": "partial", "artifact_refs": [artifact]}, "completed"),
        skillctl._event(
            {**common, "status": "failed", "error": {"code": "FORECAST_FAILED", "message": "failed"}},
            "failed",
        ),
        skillctl._event({**common, "status": "cancelled"}, "cancelled"),
    ]

    assert_skill_events_match_contract(events)
    by_kind = {item["kind"]: item for item in events}
    assert "progress" not in by_kind["started"]
    assert by_kind["progress"]["progress"] == common["progress"]
    assert by_kind["needs_input"]["questions"] == questions
    assert by_kind["artifact"]["artifact_id"] == artifact["artifact_id"]
    assert by_kind["artifact"]["manifest_relative_path"] == artifact["manifest_relative_path"]
    assert by_kind["completed"]["outcome"] == "partial"
    assert by_kind["completed"]["result_refs"] == [
        {
            "artifact_id": "artifact-1",
            "artifact_type": "ForecastBundle",
            "status": "partial",
            "manifest_url": "/api/v1/sessions/session-1/artifacts?turn_id=turn-1",
        }
    ]
    assert by_kind["failed"]["error"]["code"] == "TURN_FAILED"
    assert set(by_kind["failed"]["error"]) == {
        "type",
        "title",
        "status",
        "detail",
        "code",
        "correlation_id",
    }
    assert all("progress" not in event for kind, event in by_kind.items() if kind != "progress")
