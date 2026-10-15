import { AlertTriangle } from 'lucide-react';
import type { Artifact } from '../domain';
import { artifactVisualizationDescriptors } from '../ui/visualizations';
import { ArtifactVisualizationGallery } from './ArtifactVisualizationGallery';

const HIDDEN_FORECAST_CHART_IDS = new Set([
  'metrics_overview',
  'model_summary',
  'forecast_summary',
  'training_history',
  'error_by_horizon',
]);

const EVALUATION_METRIC_KEYS = [
  'cvrmse_percent',
  'rmse',
  'mae',
  'r2',
  'evaluation_coverage',
  'count',
] as const;

const FORECAST_METRIC_KEYS = [
  'prediction_count',
  'missing_label_count',
  'evaluation_coverage',
  'negative_raw_count',
  'negative_raw_ratio',
  'minimum_raw_prediction',
] as const;

const MODEL_SUMMARY_KEYS = [
  'model_type',
  'maximum_horizon_step',
  'best_iteration',
  'training_duration_seconds',
] as const;

const ROLLING_METRIC_KEYS = [
  'selected_model_type',
  'mae',
  'rmse',
  'cvrmse_percent',
  'r2',
  'count',
] as const;

type DisplayRow = readonly [name: string, value: string];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function displayValue(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)
      : null;
  }
  return typeof value === 'string' || typeof value === 'boolean' ? String(value) : null;
}

function label(key: string): string {
  const labels: Record<string, string> = {
    cvrmse_percent: 'CVRMSE',
    rmse: 'RMSE',
    mae: 'MAE',
    r2: 'R²',
    evaluation_coverage: '评价覆盖率',
    count: '评价样本数',
    prediction_count: '预测点数',
    missing_label_count: '缺失标签数',
    negative_raw_count: '原始负值数',
    negative_raw_ratio: '原始负值占比',
    minimum_raw_prediction: '最小原始预测值',
    model_type: '模型类型',
    maximum_horizon_step: '最大预测步长',
    best_iteration: '最佳迭代',
    training_duration_seconds: '训练耗时（秒）',
    selected_model_type: '选择模型',
  };
  return labels[key] ?? key.replaceAll('_', ' ');
}

function rowsFrom(
  source: Record<string, unknown>,
  keys: readonly string[],
): DisplayRow[] {
  return keys.flatMap((key) => {
    const value = displayValue(source[key]);
    return value === null ? [] : [[label(key), value] as const];
  });
}

function metricRows(artifact: Artifact): DisplayRow[] {
  const summary = artifact.summary;
  if (/model/i.test(artifact.artifactType)) {
    return rowsFrom(summary, MODEL_SUMMARY_KEYS);
  }
  const metrics = record(summary.metrics);
  const testMetrics = metrics ? record(metrics.test) : null;
  const predictionSummary = record(summary.prediction_summary);
  if (testMetrics) return rowsFrom(testMetrics, EVALUATION_METRIC_KEYS);
  if (predictionSummary) return rowsFrom(predictionSummary, FORECAST_METRIC_KEYS);
  if (!metrics) return [];
  return Object.entries(metrics)
    .flatMap(([key, value]) => {
      const display = displayValue(value);
      return key === 'status' || display === null ? [] : [[label(key), display] as const];
    })
    .slice(0, 6);
}

function metricTitle(artifact: Artifact): string {
  if (/model/i.test(artifact.artifactType)) return '模型信息';
  const metrics = record(artifact.summary.metrics);
  if (metrics && record(metrics.test)) return '评价指标';
  if (record(artifact.summary.prediction_summary)) return '预测摘要';
  return '权威指标';
}

function rollingMetricRows(artifact: Artifact): DisplayRow[] {
  const metrics = record(artifact.summary.metrics);
  const rolling = metrics ? record(metrics.rolling_one_step_diagnostic) : null;
  const test = rolling ? record(rolling.test) : null;
  if (!rolling || rolling.status !== 'available' || !test) return [];
  return [
    ...rowsFrom(rolling, ['selected_model_type']),
    ...rowsFrom(
      test,
      ROLLING_METRIC_KEYS.filter((key) => key !== 'selected_model_type'),
    ),
  ];
}

function chartId(value: unknown): string | null {
  const visualization = record(value);
  const id = visualization?.chart_id ?? visualization?.chartId;
  return typeof id === 'string' ? id : null;
}

function displayArtifact(artifact: Artifact): Artifact {
  const visualizations = artifact.summary.visualizations;
  if (!Array.isArray(visualizations)) return artifact;
  return {
    ...artifact,
    summary: {
      ...artifact.summary,
      visualizations: visualizations.filter((visualization) => {
        const id = chartId(visualization);
        return id === null || !HIDDEN_FORECAST_CHART_IDS.has(id);
      }),
    },
  };
}

function hasVisibleForecastCharts(artifact: Artifact): boolean {
  const descriptors = artifactVisualizationDescriptors(artifact).filter(
    (descriptor) => descriptor.businessCategory === 'load_forecast',
  );
  return (
    descriptors.length === 0 ||
    descriptors.some((descriptor) => !HIDDEN_FORECAST_CHART_IDS.has(descriptor.chartId))
  );
}

export function ForecastResult({ artifact }: { artifact: Artifact }) {
  if (artifact.status === 'integrity_failed') {
    return (
      <div className="forecast-result" data-result-status={artifact.status}>
        <div className="result-state-banner result-state-danger" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>负荷预测结果不可用</strong>
            <p>Artifact 完整性校验失败，当前不展示指标或图表。</p>
          </div>
        </div>
      </div>
    );
  }
  const summary = artifact.summary;
  const factValues: ReadonlyArray<readonly [string, unknown]> = [
    ['模式', summary.mode],
    ['目标点位', summary.target_point_id],
    ['预测周期', summary.horizon_hours],
    ['时区', summary.timezone],
    ['起始时间', summary.start_at],
    ['结束时间', summary.end_at],
  ];
  const facts: DisplayRow[] = factValues.flatMap(([name, value]) => {
    const display = displayValue(value);
    return display === null ? [] : [[name, display] as const];
  });
  const rows = metricRows(artifact);
  const rollingRows = rollingMetricRows(artifact);
  const metricsTitle = metricTitle(artifact);
  const showVisualizations = hasVisibleForecastCharts(artifact);
  const artifactForDisplay = displayArtifact(artifact);

  return (
    <div className="forecast-result" data-result-status={artifact.status}>
      {artifact.status === 'partial' && (
        <div className="result-state-banner result-state-attention" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>负荷预测结果部分完成</strong>
            <p>以下内容仅包含服务端已发布并通过当前完整性检查的结果。</p>
          </div>
        </div>
      )}
      {showVisualizations && (
        <ArtifactVisualizationGallery
          artifacts={[artifactForDisplay]}
          businessCategory="load_forecast"
          title="负荷预测图表"
          emptyMessage="负荷预测 Artifact 未发布可用预测图表。"
        />
      )}
      {facts.length > 0 && (
        <section className="forecast-table-section" aria-labelledby={`forecast-context-${artifact.id}`}>
          <h4 id={`forecast-context-${artifact.id}`}>预测范围</h4>
          <div className="forecast-table-wrap">
            <table className="forecast-table">
              <tbody>
                {facts.map(([name, value]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <section className="forecast-table-section" aria-labelledby={`forecast-metrics-${artifact.id}`}>
          <h4 id={`forecast-metrics-${artifact.id}`}>{metricsTitle}</h4>
          <div className="forecast-table-wrap">
            <table className="forecast-table">
              <tbody>
                {rows.map(([name, value]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {rollingRows.length > 0 && (
        <section
          className="forecast-table-section"
          aria-labelledby={`forecast-rolling-metrics-${artifact.id}`}
        >
          <h4 id={`forecast-rolling-metrics-${artifact.id}`}>滚动一步（当日观测反馈）</h4>
          <div className="forecast-table-wrap">
            <table className="forecast-table">
              <tbody>
                {rollingRows.map(([name, value]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
