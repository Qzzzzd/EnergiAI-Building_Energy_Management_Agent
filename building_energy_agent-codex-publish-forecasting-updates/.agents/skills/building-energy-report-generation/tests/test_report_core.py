from __future__ import annotations

import hashlib
import json
import struct
import zlib
from pathlib import Path

import pytest

from report_generation.core import ReportFailure, generate_report


def _png(color: tuple[int, int, int]) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"\x00" + bytes(color)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


PNG = _png((54, 112, 148))


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _source(
    root: Path,
    artifact_id: str,
    artifact_type: str,
    summary: dict,
    native: dict | None = None,
    *,
    partial: bool = False,
    chart_ids: list[str] | None = None,
) -> str:
    public = root / "public-artifacts" / artifact_id
    public.mkdir(parents=True)
    files = []
    if native is not None:
        native_path = public / "native-manifest.json"
        native_path.write_text(json.dumps(native), encoding="utf-8")
        files.append(
            {
                "relative_path": f"public-artifacts/{artifact_id}/native-manifest.json",
                "media_type": "application/json; charset=utf-8",
                "size_bytes": native_path.stat().st_size,
                "sha256": _sha(native_path),
                "role": "native-manifest",
            }
        )
    requested_chart_ids = chart_ids or ["quality_score_overview"]
    for chart_id in requested_chart_ids:
        figure_path = public / "figures" / f"{chart_id}.png"
        figure_path.parent.mkdir(exist_ok=True)
        color_seed = sum(chart_id.encode("ascii")) % 255
        figure_path.write_bytes(PNG if len(requested_chart_ids) == 1 else _png((color_seed, 112, 148)))
        files.append(
            {
                "relative_path": f"public-artifacts/{artifact_id}/figures/{chart_id}.png",
                "media_type": "image/png",
                "size_bytes": figure_path.stat().st_size,
                "sha256": _sha(figure_path),
                "role": "visualization",
            }
        )
    manifest = {
        "schema_version": "1.0",
        "artifact_id": artifact_id,
        "artifact_type": artifact_type,
        "producer": {"skill_name": "fixture", "job_id": "job-" + "1" * 32},
        "source_ids": ["src:fixture"],
        "status": "partial" if partial else "succeeded",
        "files": files,
        "summary": summary,
        "warnings": ["fixture warning"] if partial else [],
    }
    (public / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return artifact_id


def _quality(root: Path, *, partial: bool = False, chart_ids: list[str] | None = None) -> str:
    return _source(
        root,
        "artifact-quality-fixture",
        "QualityAssessmentBundle",
        {
            "overall_score": 82.5,
            "dimensions": {"DQ1": {"status": "available", "score": 82.5, "summary": "公开摘要"}},
            "issues": [],
            "effective_scope": {"time_start": "2025-01-01T00:00:00+00:00", "time_end": "2025-01-02T00:00:00+00:00"},
        },
        {"bundle_type": "QualityAssessmentBundle", "source_bundle_id": "dataset-fixture", "formula_version": "dq-v1"},
        partial=partial,
        chart_ids=chart_ids,
    )


def test_missing_integrated_source_returns_needs_input(tmp_path: Path) -> None:
    result = generate_report(
        {"report_type": "integrated", "source_artifact_ids": {}},
        artifact_root=tmp_path,
        job_id="job-" + "2" * 32,
    )
    assert result["status"] == "needs_input"
    assert {question["id"] for question in result["required_inputs"]} == {
        "source_artifact_ids.quality",
        "source_artifact_ids.evaluation 或 forecast",
    }


def test_quality_report_is_self_contained_and_cached(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path)
    request = {"report_type": "quality", "source_artifact_ids": {"quality": artifact_id}}
    first = generate_report(request, artifact_root=tmp_path, job_id="job-" + "3" * 32)
    assert first["status"] == "succeeded"
    assert first["qa"]["self_contained"] is True
    assert first["qa"]["chart_count"] == 1
    assert first["qa"]["pdf"]["self_contained"] is True
    assert first["qa"]["pdf_size_bytes"] > 0
    assert first["summary"]["narrative"]["mode"] == "deterministic-fallback"
    assert first["summary"]["narrative"]["covered_sections"] == 5
    assert first["summary"]["narrative"]["eligible_sections"] == 5
    assert first["summary"]["narrative"]["character_count"] > 400
    assert first["summary"]["narrative"]["visual_note_count"] == 6
    assert first["qa"]["visual_note_count"] == 6
    report_manifest = tmp_path / first["artifact_refs"][0]["manifest_relative_path"]
    manifest = json.loads(report_manifest.read_text(encoding="utf-8"))
    assert {file["relative_path"].rsplit("/", 1)[-1] for file in manifest["files"]} == {
        "report.html",
        "report.pdf",
    }
    html_file = next(file for file in manifest["files"] if file["media_type"].startswith("text/html"))
    report = (tmp_path / html_file["relative_path"]).read_text(encoding="utf-8")
    pdf_file = next(file for file in manifest["files"] if file["media_type"] == "application/pdf")
    pdf = (tmp_path / pdf_file["relative_path"]).read_bytes()
    assert pdf.startswith(b"%PDF-")
    assert b"http://" not in pdf and b"https://" not in pdf and b"www.reportlab.com" not in pdf
    assert "data:image/png;base64," in report
    assert "<script" not in report.lower()
    assert report.count('class="narrative"') == 5
    assert report.count('class="visual-analysis"') == 6
    assert "分析解读" in report
    assert "图表解读" in report and "表格解读" in report
    assert b"TimesNewRoman" in pdf and b"STSong-Light" in pdf
    second = generate_report(request, artifact_root=tmp_path, job_id="job-" + "4" * 32)
    assert second["cached"] is True
    assert second["artifact_refs"] == first["artifact_refs"]


def test_codex_narrative_is_accepted_and_shared_by_formats(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path)
    body = (
        "公开质量摘要提供了综合评分、维度状态和问题清单，因此本节可以解释当前结果的治理含义。"
        "这些解释只围绕已验证事实展开，不把并列结果扩写成未经证明的设备原因。"
        "工程人员仍需结合来源版本、问题严重性和后续复核结果理解本节结论。"
    )
    request = {
        "report_type": "quality",
        "source_artifact_ids": {"quality": artifact_id},
        "narrative_blocks": [
            {
                "section_id": "quality-diagnosis",
                "takeaway": "当前质量结果可追溯，治理重点应回到公开问题证据。",
                "body": body,
                "evidence_refs": [artifact_id],
                "fact_refs": ["fact:quality"],
                "chart_refs": ["quality_score_overview"],
                "caveats": ["该解读不替代设备协议和运行日志。"],
                "visual_notes": [
                    {"kind": "chart", "ref": "quality_score_overview", "text": "六个质量维度的相对差异应与质量问题表交叉核对，不单独解释根因。"},
                    {"kind": "table", "ref": "六维质量结果", "text": "逐行核对状态、评分和公开摘要，先定位治理优先级再查看具体问题。"},
                ],
            }
        ],
    }
    result = generate_report(request, artifact_root=tmp_path, job_id="job-" + "7" * 32)
    assert result["status"] == "succeeded"
    assert result["summary"]["narrative"]["mode"] == "mixed"
    assert "quality-diagnosis" not in result["summary"]["narrative"]["fallback_sections"]
    assert "Codex" not in result["warnings"]
    manifest_path = tmp_path / result["artifact_refs"][0]["manifest_relative_path"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    html_path = next(path for path in manifest["files"] if path["media_type"].startswith("text/html"))
    report = (tmp_path / html_path["relative_path"]).read_text(encoding="utf-8")
    assert "当前质量结果可追溯" in report
    assert "关联图表：</b>六维质量评分" in report
    assert "六个质量维度的相对差异" in report
    assert manifest["summary"]["narrative"]["block_count"] == 5
    assert manifest["summary"]["qa"]["pdf"]["narrative_count"] == 5


def test_invalid_numeric_and_chart_claims_fall_back(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path)
    body = (
        "公开质量摘要能够支持章节解释，但这里加入了来源事实中不存在的数值，"
        "因此整块文字不能作为可追溯报告结论。工程人员仍需结合来源版本、问题严重性和后续复核结果理解这段结论。"
    )
    chart_result = generate_report(
        {
            "report_type": "quality",
            "source_artifact_ids": {"quality": artifact_id},
            "narrative_blocks": [
                {
                    "section_id": "executive-summary",
                    "takeaway": "综合评分为 999.99 分。",
                    "body": body,
                    "evidence_refs": [artifact_id],
                    "fact_refs": ["fact:quality"],
                    "chart_refs": ["not-selected"],
                }
            ],
        },
        artifact_root=tmp_path,
        job_id="job-" + "8" * 32,
    )
    assert chart_result["status"] == "partial"
    assert any("未选中的图表" in warning for warning in chart_result["warnings"])
    numeric_result = generate_report(
        {
            "report_type": "quality",
            "source_artifact_ids": {"quality": artifact_id},
            "narrative_blocks": [
                {
                    "section_id": "executive-summary",
                    "takeaway": "综合评分为 999.99 分。",
                    "body": body,
                    "evidence_refs": [artifact_id],
                    "fact_refs": ["fact:quality"],
                    "chart_refs": ["quality_score_overview"],
                }
            ],
        },
        artifact_root=tmp_path,
        job_id="job-" + "b" * 32,
    )
    assert numeric_result["status"] == "partial"
    assert any("数字" in warning for warning in numeric_result["warnings"])
    assert numeric_result["summary"]["narrative"]["mode"] == "deterministic-fallback"


def test_narrative_change_invalidates_cache(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path)
    base = {"report_type": "quality", "source_artifact_ids": {"quality": artifact_id}}
    first = generate_report(base, artifact_root=tmp_path, job_id="job-" + "9" * 32)
    changed = {
        **base,
        "narrative_blocks": [
            {
                "section_id": "executive-summary",
                "takeaway": "质量来源已经完成完整性校验，解释应聚焦证据边界。",
                "body": "公开摘要足以支持一段面向工程人员的解释。该段文字不增加新的数字，也不把质量结果解释为设备原因。工程人员仍需结合来源版本、问题严重性和后续复核结果理解这段结论内容。",
                "evidence_refs": [artifact_id],
                "fact_refs": ["fact:quality"],
            }
        ],
    }
    second = generate_report(changed, artifact_root=tmp_path, job_id="job-" + "a" * 32)
    assert second.get("cached") is not True
    assert second["artifact_refs"] != first["artifact_refs"]


def test_chart_selection_drops_redundant_visuals(tmp_path: Path) -> None:
    artifact_id = _quality(
        tmp_path,
        chart_ids=["quality_score_overview", "quality_overall_score", "issue_severity_counts", "issues_by_dimension", "affected_scope_summary"],
    )
    result = generate_report(
        {"report_type": "quality", "source_artifact_ids": {"quality": artifact_id}},
        artifact_root=tmp_path,
        job_id="job-" + "c" * 32,
    )
    selected = [item["chart_id"] for item in result["summary"]["selected_charts"]]
    assert selected == ["quality_score_overview", "issue_severity_counts", "issues_by_dimension"]
    assert result["summary"]["qa"]["chart_count"] == 3
    assert result["summary"]["qa"]["visual_note_count"] == 8


def test_partial_source_and_numeric_narrative_fall_back(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path, partial=True)
    result = generate_report(
        {
            "report_type": "quality",
            "source_artifact_ids": {"quality": artifact_id},
            "narrative_blocks": [
                {
                    "section_id": "executive-summary",
                    "takeaway": "评分为 99 分",
                    "body": "没有事实引用。",
                    "evidence_refs": [artifact_id],
                }
            ],
        },
        artifact_root=tmp_path,
        job_id="job-" + "5" * 32,
    )
    assert result["status"] == "partial"
    assert any("叙事块" in warning for warning in result["warnings"])


def test_manifest_hash_mismatch_fails(tmp_path: Path) -> None:
    artifact_id = _quality(tmp_path)
    figure = next((tmp_path / "public-artifacts" / artifact_id / "figures").glob("*.png"))
    figure.write_bytes(b"changed")
    with pytest.raises(ReportFailure) as error:
        generate_report(
            {"report_type": "quality", "source_artifact_ids": {"quality": artifact_id}},
            artifact_root=tmp_path,
            job_id="job-" + "6" * 32,
        )
    assert error.value.code == "ARTIFACT_INTEGRITY_FAILED"
