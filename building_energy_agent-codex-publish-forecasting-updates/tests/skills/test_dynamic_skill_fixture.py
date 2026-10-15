from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / "test-data/dynamic-skill/building-energy-dynamic-proof/scripts/run"
PREFIX = "BE_SKILL_EVENT "


def assert_dynamic_output_matches_typescript_contract(events: list[dict], manifest: dict) -> None:
    script = """
import { readFileSync } from 'node:fs';
import { ArtifactManifestSchema, SkillEventSchema } from './packages/contracts/src/index.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
for (const event of input.events) SkillEventSchema.parse(event);
ArtifactManifestSchema.parse(input.manifest);
"""
    checked = subprocess.run(
        [str(PROJECT / "node_modules" / ".bin" / "tsx"), "--eval", script],
        cwd=PROJECT,
        input=json.dumps({"events": events, "manifest": manifest}),
        text=True,
        capture_output=True,
        timeout=15,
        check=False,
    )
    assert checked.returncode == 0, checked.stderr


def test_dynamic_skill_fixture_emits_progress_and_a_hash_valid_public_artifact(tmp_path: Path) -> None:
    completed = subprocess.run(
        [
            str(SCRIPT),
            "--session-id",
            "session-dynamic",
            "--turn-id",
            "turn-dynamic",
            "--workspace-root",
            str(tmp_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    events = [json.loads(line.removeprefix(PREFIX)) for line in completed.stdout.splitlines()]
    assert [event["kind"] for event in events] == ["started", "progress", "artifact", "completed"]
    assert all(line.startswith(PREFIX) for line in completed.stdout.splitlines())
    assert events[-1]["result_refs"][0]["manifest_url"] == (
        "/api/v1/sessions/session-dynamic/artifacts?turn_id=turn-dynamic"
    )

    manifest_path = tmp_path / "artifacts/dynamic-proof-turn-dynamic/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert_dynamic_output_matches_typescript_contract(events, manifest)
    artifact_file = tmp_path / "artifacts" / manifest["files"][0]["relative_path"]
    content = artifact_file.read_bytes()
    assert len(content) == manifest["files"][0]["size_bytes"]
    assert hashlib.sha256(content).hexdigest() == manifest["files"][0]["sha256"]
    assert manifest["producer"]["skill_name"] == "building-energy-dynamic-proof"
