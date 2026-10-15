# Report design and QA reference

## Fixed section skeletons

Integrated reports use:

1. 执行摘要与关键结论
2. 数据范围与证据链
3. 数据质量诊断
4. 数据处理与可建模性
5. 负荷预测评价
6. 未来负荷预测
7. 风险、限制与行动建议

Specialized reports use:

- `quality`: 执行摘要、数据范围、六维质量诊断、关键问题与建议、证据详情
- `forecast-evaluation`: 执行摘要、评价范围与方法、核心指标、分预测步长误差与预测对比、风险与适用边界
- `forecast-future`: 执行摘要、预测对象与时间范围、未来负荷曲线、峰值与范围、使用限制与监测建议

Keep core section headings visible in a partial report. Put `未提供` and the
actual reason in the section instead of silently deleting the section.

## Narrative layout

Every section backed by a verifiable source should contain an `分析解读` block
before its facts, figures, and tables. The block follows this order:

1. one-line takeaway;
2. two-to-four short paragraphs explaining the observed result and its
   operational meaning;
3. optional caveats and next action;
4. optional related chart labels.

Codex supplies the first version from public facts. The renderer validates
source/fact/chart references and uses a deterministic fallback when the block
is missing or unsafe. The fallback is a readable evidence explanation, not a
new metric calculation. HTML and PDF must render the same narrative blocks in
the same chapter order. Do not fill a missing-source chapter with generic
analysis; preserve its evidence-gap message.

## Chart registry

Use only a source VisualizationBundle PNG whose hash and PNG signature pass.
The report deliberately curates the following reader-facing set instead of
embedding every registered figure:

- quality: `quality_score_overview`, `issue_severity_counts`,
  `issues_by_dimension`;
- processing: `processed_target_timeline`, `split_timeline`;
- evaluation: `metrics_overview`, `actual_vs_prediction`, `error_by_horizon`;
- future: `forecast_timeseries`.

The broader registry remains available for provenance and compatibility, but
single-value/text-on-canvas figures and dense scatter/diagnostic figures are
omitted when a fact card or exact table communicates the evidence more clearly.
An omitted figure is not regenerated or inferred from raw data.

Existing aliases such as `test_actual_vs_prediction` and
`feature_importance_gain_top20` may map to the fixed canonical IDs. The
integrated report selects at most eight charts. A missing selected chart becomes
an evidence-gap warning and never triggers a replacement chart made from raw data.

## Visual explanation contract

Every selected chart and every rendered evidence table is preceded by a compact
reader-facing explanation. It follows the adapted consulting sequence
“visual anchor → evidence/table contrast → integrated analysis”:

1. tell the reader what to look at;
2. state the comparison, direction, or exact lookup that matters;
3. state the implication or boundary, without inventing a cause.

Codex may supply `visual_notes`; the deterministic renderer fills missing notes
from the cited public facts and validates numeric claims. HTML and PDF use the
same note text and order.

## Visual and safety tokens

Use a single-column, approximately 1120px report with a white/light-gray
surface, deep navy headings, graphite text, teal normal state, orange attention,
and red risk. Use system Chinese font fallbacks. Keep charts large enough to
read on screen and in print. Use tables as a fallback for compact facts.

The final HTML must contain no `<script>`, external `src`/`href`, `iframe`,
`form`, `@import`, remote URL, or unescaped user-supplied HTML. Every image must
be a `data:image/png;base64,...` URI. Run a byte-level self-contained scan,
verify the report file hash, and verify the size limit before publishing.

The PDF uses the same section data, tables, and verified PNG files as HTML. The
main body is 12pt (小四), Chinese uses `STSong-Light` (宋体), and Latin letters
and numbers use embedded Times New Roman. Headings use a larger hierarchy and
the same Chinese font family so mixed Chinese/Latin lines remain stable. It has
no active annotations or external references, and is checked for a valid PDF
header, EOF marker, required font resources, image count, narrative count,
visual-note count, and size before the Artifact is published. The cover exposes
the narrative mode and covered/eligible chapter count for auditability; it does
not expose hidden model reasoning.

## Reference principles adapted

The implementation adapts two public report-building patterns while preserving
the project Artifact boundary:

- [Deer-Flow consulting-analysis](https://github.com/bytedance/deer-flow/tree/main/skills/public/consulting-analysis): use a visual anchor, then evidence contrast, then integrated “what → why → so what” interpretation; generate/validate visuals before final narrative.
- [OpenAI build-report](https://github.com/openai/role-specific-plugins/tree/main/plugins/data-analytics/skills/build-report): every visual gets an adjacent explanatory paragraph, tables are used for exact lookup/audit detail, dense visuals are not shrunk into unreadable cards, and the rendered report itself is inspected before handoff.

Not adopted: external web research, raw-data access, model-authored replacement
charts, interactive runtime dependencies, or the reference skills’ audience and
delivery modes that are outside this building-energy Skill.
