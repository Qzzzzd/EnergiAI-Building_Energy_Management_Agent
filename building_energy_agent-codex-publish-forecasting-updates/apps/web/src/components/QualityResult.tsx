import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Artifact } from '../domain';

const dimensionLabels: Record<string, string> = {
  DQ1: '完整性',
  DQ2: '准确性',
  DQ3: '全面性',
  DQ4: '值域覆盖',
  DQ5: '一致性',
  DQ6: '信息熵',
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function dimensions(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.map(record).filter((item) => item !== null);
  const source = record(value);
  if (!source) return [];
  return Object.entries(source).flatMap(([id, item]) => {
    const detail = record(item);
    return detail ? [{ id, ...detail }] : [];
  });
}

function issues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record).filter((item) => item !== null) : [];
}

interface QualityDimension {
  id: string;
  label: string;
  score: number | null;
  unavailable: boolean;
  summary: string | null;
}

const radarDimensionIds = ['DQ1', 'DQ2', 'DQ3', 'DQ4', 'DQ5', 'DQ6'];
const radarSize = 340;
const radarCenter = radarSize / 2;
const radarRadius = 104;

function radarPoint(index: number, ratio: number): { x: number; y: number } {
  const angle = (Math.PI * 2 * index) / radarDimensionIds.length - Math.PI / 2;
  return {
    x: radarCenter + Math.cos(angle) * radarRadius * ratio,
    y: radarCenter + Math.sin(angle) * radarRadius * ratio,
  };
}

function points(points: Array<{ x: number; y: number }>): string {
  return points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function QualityRadarChart({ dimensions }: { dimensions: QualityDimension[] }) {
  const radarDimensions = radarDimensionIds
    .map((id) => dimensions.find((dimension) => dimension.id === id))
    .filter((dimension): dimension is QualityDimension => Boolean(dimension));
  const scores = radarDimensions.map((dimension) =>
    !dimension.unavailable &&
    typeof dimension.score === 'number' &&
    Number.isFinite(dimension.score) &&
    dimension.score >= 0 &&
    dimension.score <= 100
      ? dimension.score
      : null,
  );
  const verifiedScores = scores.filter((score): score is number => score !== null);
  if (radarDimensions.length !== radarDimensionIds.length || verifiedScores.length !== radarDimensionIds.length) {
    return <p className="quality-empty-state">服务端未发布完整的六维评分，暂不绘制雷达图。</p>;
  }

  const grid = [0.25, 0.5, 0.75, 1].map((ratio) =>
    points(radarDimensionIds.map((_, index) => radarPoint(index, ratio))),
  );
  const dataPoints = points(verifiedScores.map((score, index) => radarPoint(index, score / 100)));
  const description = radarDimensions
    .map((dimension, index) => `${dimension.label} ${verifiedScores[index]!.toFixed(1)} 分`)
    .join('；');

  return (
    <svg
      className="quality-radar-chart"
      viewBox={`0 0 ${radarSize} ${radarSize}`}
      role="img"
      aria-label="六维质量评分雷达图"
    >
      <title>六维质量评分雷达图</title>
      <desc>{description}</desc>
      {grid.map((gridPoints, index) => (
        <polygon className="quality-radar-grid" points={gridPoints} key={index} />
      ))}
      {radarDimensionIds.map((id, index) => {
        const axis = radarPoint(index, 1);
        const label = radarPoint(index, 1.22);
        const score = verifiedScores[index]!;
        const dimension = radarDimensions[index]!;
        const textAnchor = label.x < radarCenter - 12 ? 'end' : label.x > radarCenter + 12 ? 'start' : 'middle';
        return (
          <g key={id}>
            <line className="quality-radar-axis" x1={radarCenter} y1={radarCenter} x2={axis.x} y2={axis.y} />
            <text className="quality-radar-label" x={label.x} y={label.y - 4} textAnchor={textAnchor}>
              {dimension.label}
            </text>
            <text className="quality-radar-score" x={label.x} y={label.y + 10} textAnchor={textAnchor}>
              {score.toFixed(1)}
            </text>
          </g>
        );
      })}
      <polygon className="quality-radar-area" points={dataPoints} />
      {verifiedScores.map((score, index) => {
        const point = radarPoint(index, score / 100);
        return <circle className="quality-radar-point" cx={point.x} cy={point.y} r="3.5" key={radarDimensionIds[index]} />;
      })}
    </svg>
  );
}

export function QualityResult({ artifact }: { artifact: Artifact }) {
  if (artifact.status === 'integrity_failed') {
    return (
      <div className="quality-result" data-result-status={artifact.status}>
        <div className="result-state-banner result-state-danger" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>数据质量结果不可用</strong>
            <p>Artifact 完整性校验失败，当前不展示指标或图表。</p>
          </div>
        </div>
      </div>
    );
  }
  const summary = artifact.summary;
  const conclusion = text(summary.conclusion);
  const overall = typeof summary.overall_score === 'number' ? summary.overall_score : null;
  const dimensionRows = dimensions(summary.dimensions);
  const issueRows = issues(summary.issues);
  const recommendations = Array.isArray(summary.recommendations)
    ? summary.recommendations.map(text).filter((item) => item !== null)
    : [];
  const normalizedDimensions: QualityDimension[] = dimensionRows.map((dimension, index) => {
    const id = text(dimension.id) ?? `维度 ${index + 1}`;
    return {
      id,
      label: dimensionLabels[id] ?? text(dimension.label) ?? id,
      score: typeof dimension.score === 'number' ? dimension.score : null,
      unavailable: dimension.status === 'unavailable',
      summary: text(dimension.summary),
    };
  });
  const needsAttention = (dimension: QualityDimension) =>
    dimension.unavailable || dimension.score === null || dimension.score < 70;
  const priorityDimensions = normalizedDimensions.filter(needsAttention);
  const evidenceDimensions = normalizedDimensions.filter((dimension) => !needsAttention(dimension));
  const normalizedIssues = issueRows.map((issue, index) => {
    const dimensionId = text(issue.dimension);
    const dimension = normalizedDimensions.find((item) => item.id === dimensionId);
    return {
      id: `${dimensionId ?? 'issue'}-${index}`,
      dimensionLabel: dimension ? `${dimension.id} ${dimension.label}` : (dimensionId ?? '数据质量'),
      score: dimension?.score ?? null,
      severity: text(issue.severity) ?? 'info',
      summary: text(issue.summary) ?? text(issue.issue_type) ?? '质量问题',
    };
  });
  const qualityStatus = artifact.status === 'partial' ? '结果部分可用' : '评估已完成';
  const QualityStatusIcon = artifact.status === 'partial' ? AlertTriangle : CheckCircle2;
  const dimensionCard = (dimension: QualityDimension) => {
    const attention = needsAttention(dimension);
    const tag = dimension.unavailable ? '暂不可用' : attention ? '优先处理' : '可用依据';
    return (
      <article
        className={`dimension-insight-card ${
          attention ? 'dimension-insight-card-priority' : 'dimension-insight-card-evidence'
        }`}
        key={dimension.id}
      >
        <div className="dimension-insight-heading">
          <span>{dimension.id}</span>
          <strong>{dimension.label}</strong>
          <b>{dimension.score === null ? '不可用' : dimension.score.toFixed(1)}</b>
        </div>
        {dimension.summary && <p>{dimension.summary}</p>}
        <small>{tag}</small>
      </article>
    );
  };

  return (
    <div className="quality-result" data-result-status={artifact.status}>
      {artifact.status === 'partial' && (
        <div className="result-state-banner result-state-attention" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>数据质量结果部分完成</strong>
            <p>以下内容仅包含服务端已发布并通过当前完整性检查的结果。</p>
          </div>
        </div>
      )}
      {(conclusion || overall !== null) && (
        <div className="quality-overview" aria-label="数据质量综合评分">
          <span className="score-ring">
            <strong>{overall === null ? '—' : overall.toFixed(1)}</strong>
            <small>综合质量分</small>
          </span>
          <div className="quality-scope">
            <span className="quality-scope-label">评估结论</span>
            <p>{conclusion ?? '服务端未发布可展示的业务结论。'}</p>
          </div>
          <div
            className={`quality-overview-status${artifact.status === 'partial' ? ' attention' : ''}`}
          >
            <QualityStatusIcon size={18} aria-hidden="true" />
            <span>{qualityStatus}</span>
          </div>
        </div>
      )}

      {(normalizedDimensions.length > 0 || normalizedIssues.length > 0) && (
        <div className="quality-analysis-grid">
          <section className="quality-analysis-panel quality-issues-panel" aria-labelledby={`quality-issues-${artifact.id}`}>
            <div className="quality-section-heading">
              <h3 id={`quality-issues-${artifact.id}`}>问题分析</h3>
              <span>{normalizedIssues.length} 项</span>
            </div>
            {normalizedIssues.length > 0 ? (
              <div className="quality-issue-list">
                {normalizedIssues.map((issue, index) => (
                  <article className={`quality-issue-card severity-${issue.severity}`} key={issue.id}>
                    <span className="quality-issue-index" aria-hidden="true">
                      <i />
                      {index + 1}
                    </span>
                    <div className="quality-issue-content">
                      <div className="quality-issue-title-row">
                        <strong>{issue.dimensionLabel}</strong>
                        <b>{issue.score === null ? '不可用' : issue.score.toFixed(1)}</b>
                      </div>
                      <p>{issue.summary}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="quality-empty-state">当前未发现需要处理的问题。</p>
            )}
          </section>
          <section className="quality-analysis-panel quality-radar-panel" aria-labelledby={`quality-dimensions-${artifact.id}`}>
            <div className="quality-section-heading">
              <h3 id={`quality-dimensions-${artifact.id}`}>六维质量评分</h3>
              <span>0–100</span>
            </div>
            <QualityRadarChart dimensions={normalizedDimensions} />
          </section>
        </div>
      )}

      {normalizedDimensions.length > 0 && (
        <section className="quality-interpretation" aria-labelledby={`quality-interpretation-${artifact.id}`}>
          <div className="quality-section-heading quality-interpretation-heading">
            <h3 id={`quality-interpretation-${artifact.id}`}>维度解读</h3>
            <span>按当前风险优先级排序</span>
          </div>
          {priorityDimensions.length > 0 && (
            <div className="quality-insight-group quality-insight-group-priority">
              <h4><i />优先处理</h4>
              <div className="dimension-insight-grid">{priorityDimensions.map(dimensionCard)}</div>
            </div>
          )}
          {evidenceDimensions.length > 0 && (
            <div className="quality-insight-group quality-insight-group-evidence">
              <h4><i />可用性依据</h4>
              <div className="dimension-insight-grid">{evidenceDimensions.map(dimensionCard)}</div>
            </div>
          )}
        </section>
      )}

      {recommendations.length > 0 && (
        <section className="quality-recommendation-section" aria-labelledby={`quality-actions-${artifact.id}`}>
          <h3 id={`quality-actions-${artifact.id}`}>建议</h3>
          <ul className="quality-recommendations">
            {recommendations.map((recommendation) => (
              <li key={recommendation}>{recommendation}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
