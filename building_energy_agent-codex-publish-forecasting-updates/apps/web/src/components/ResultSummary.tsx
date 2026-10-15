import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  FileSearch,
  LineChart,
  TriangleAlert,
} from 'lucide-react';
import type { Artifact, ResultReference } from '../domain';
import { artifactDisplayName } from '../ui/artifacts';

function readableLabel(key: string): string {
  const known: Record<string, string> = {
    horizon_hours: '预测周期',
    timezone: '时区',
    target_point_id: '目标点位',
    coverage: '数据覆盖',
    overall_score: '总体评分',
    status: '状态',
    start_at: '起始时间',
    end_at: '结束时间',
    unit: '单位',
    mode: '模式',
  };
  return known[key] ?? key.replaceAll('_', ' ');
}

function renderValue(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function SummaryFacts({ summary }: { summary: Record<string, unknown> }) {
  const facts: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(summary)) {
    const direct = renderValue(value);
    if (direct !== null) {
      facts.push([key, direct]);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        const nested = renderValue(nestedValue);
        if (nested !== null) facts.push([`${key}.${nestedKey}`, nested]);
      }
    }
    if (facts.length >= 8) break;
  }
  if (!facts.length) return <p className="no-facts">此结果未公开额外摘要字段。</p>;
  return (
    <dl className="result-facts">
      {facts.map(([key, value]) => (
        <div key={key}>
          <dt>{readableLabel(key)}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultIcon({ kind }: { kind: ResultReference['kind'] }) {
  if (kind === 'quality') return <FileSearch size={19} />;
  if (kind === 'forecast') return <LineChart size={19} />;
  return <BarChart3 size={19} />;
}

function resultKindLabel(kind: ResultReference['kind']): string {
  if (kind === 'quality') return '数据质量';
  if (kind === 'forecast') return '负荷预测';
  return '分析结果';
}

export function ResultSummary({
  result,
  artifact,
  onOpen,
}: {
  result: ResultReference;
  artifact: Artifact | undefined;
  onOpen?: () => void;
}) {
  const missingVisualization = artifact?.warnings.some((warning) =>
    /visual|图|plot|DEPENDENCY_MISSING/i.test(warning),
  );
  const resultState = !artifact
    ? '待验证'
    : artifact.status === 'integrity_failed'
      ? '不可用'
      : result.status === 'partial' || artifact.status === 'partial'
        ? '部分完成'
        : '已验证';
  const resultClass = !artifact ? 'missing' : result.status;
  return (
    <section
      className={`result-summary turn-result-card result-${resultClass}`}
      aria-labelledby={`result-summary-title-${result.artifactId}`}
    >
      <header>
        <span className="result-icon" aria-hidden="true">
          <ResultIcon kind={result.kind} />
        </span>
        <div>
          <span className={`result-type result-${result.kind}`}>{resultKindLabel(result.kind)}</span>
          <h3 id={`result-summary-title-${result.artifactId}`}>{result.title}</h3>
          <p>{result.summary}</p>
        </div>
        <span className="result-state">{resultState}</span>
      </header>

      {artifact && <SummaryFacts summary={artifact.summary} />}

      {!artifact && (
        <div className="result-unavailable" role="status">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>结果已登记，但服务端尚未发布可验证 Artifact；当前不展示指标或图表。</span>
        </div>
      )}

      {missingVisualization && (
        <div className="honest-degradation">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>业务结果可用，但可视化依赖缺失。这里不会生成占位图片。</span>
        </div>
      )}

      {onOpen && (
        <button className="turn-result-button result-open-action" type="button" onClick={onOpen}>
          查看结果详情
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      )}

      <details>
        <summary>
          技术详情
          <ChevronDown size={15} aria-hidden="true" />
        </summary>
        {artifact ? (
          <div className="technical-detail">
            <dl>
              <div>
                <dt>结果类型</dt>
                <dd>{artifact ? artifactDisplayName(artifact.artifactType) : '—'}</dd>
              </div>
              <div>
                <dt>已发布文件</dt>
                <dd>{artifact?.files.length ?? 0}</dd>
              </div>
              <div>
                <dt>完整性状态</dt>
                <dd>
                  {artifact
                    ? artifact.status === 'succeeded'
                      ? '已校验'
                      : artifact.status === 'partial'
                        ? '部分完成'
                        : '完整性失败'
                    : '未发布'}
                </dd>
              </div>
            </dl>
            {artifact && artifact.warnings.length > 0 && (
              <p>服务端返回 {artifact.warnings.length} 条运行告警；请查看结果中的业务说明。</p>
            )}
          </div>
        ) : (
          <p>结果索引仍在恢复；如果持续缺失，请重新打开会话或重新运行分析。</p>
        )}
      </details>
    </section>
  );
}
