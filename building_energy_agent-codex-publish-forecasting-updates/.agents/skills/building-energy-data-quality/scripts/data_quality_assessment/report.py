from __future__ import annotations

from .models import QualityProfile, QualityResult


def render_report(result: QualityResult, profile: QualityProfile) -> str:
    lines = [
        "# 数据质量评估报告",
        "",
        "## 1. 评估对象与预测目标",
        "",
        f"- 数据包：`{result.source_bundle_id}`",
        f"- 任务：`{result.assessment_context.task_type}`",
        f"- 目标点位：`{result.assessment_context.target_point_id}`",
        f"- 时间范围：{result.effective_scope.time_start} 至 {result.effective_scope.time_end}",
        f"- 纳入点位：{result.effective_scope.included_point_count} 个",
        "",
        "## 2. 公式版本与配置来源",
        "",
        f"- 公式版本：`{result.formula_version}`",
        f"- QualityProfile：`{result.quality_profile_id}`",
        "",
        "## 3. 六维得分",
        "",
        "| 维度 | 状态 | 得分 | 说明 |",
        "|---|---|---:|---|",
    ]
    names = {"DQ1": "完整性", "DQ2": "准确性", "DQ3": "全面性", "DQ4": "范围", "DQ5": "一致性", "DQ6": "信息熵"}
    for key in [f"DQ{i}" for i in range(1, 7)]:
        item = result.dimensions[key]
        score = "不可计算" if item.score is None else f"{item.score:.2f}"
        detail = item.summary + (f"（{item.reason_code}）" if item.reason_code else "")
        lines.append(f"| {key} {names[key]} | {item.status} | {score} | {detail} |")
    lines.extend(["", "## 4. 综合得分", ""])
    lines.append("因存在不可计算维度，本次不生成综合得分。" if result.overall_score is None else f"综合得分：**{result.overall_score:.2f}**")
    lines.extend(["", "## 5. 主要数据质量问题", ""])
    if not result.issues:
        lines.append("未发现需要聚合报告的问题。")
    for issue in result.issues:
        lines.append(f"- **[{issue.severity}] {issue.dimension}｜{issue.issue_type}**：{issue.summary} 建议：{issue.recommended_action}")
    lines.extend(["", "## 6. 处理建议", "", "Skill 3 只识别、评分和报告问题，不修改源数据。请在数据处理或采集治理环节执行建议，并保留原始值和处理标记。"])
    lines.extend(["", "## 7. 推断参数与依据", ""])
    inferred = [item for item in profile.parameter_provenance if item.source_type == "agent_inferred"]
    if not inferred:
        lines.append("本次配置没有 Agent 推断参数。")
    for item in inferred:
        lines.append(f"- `{item.parameter}`：{item.basis}；置信度：{item.confidence}。")
    lines.extend(["", "## 8. 限制说明", "", "- 评分绑定当前任务、目标和 Profile，不应跨 Schema 直接比较。", "- 严重度只用于报告排序，不阻止 Skill 2 或 Skill 4。", "- MVP 推断量程不能替代 BMS 数据字典、设备协议或运行日志。", ""])
    return "\n".join(lines)
