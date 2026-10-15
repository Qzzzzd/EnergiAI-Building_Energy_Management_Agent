import { AlertTriangle, FileText, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ResultReference, SessionDetail } from '../domain';
import { artifactDisplayName, controlledContentUrl, fileRoleDisplayName } from '../ui/artifacts';
import { formatBytes } from '../ui/format';
import { ForecastResult } from './ForecastResult';
import { QualityResult } from './QualityResult';

type ResultTab = 'overview' | 'quality' | 'forecast' | 'files';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function primitive(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

function visibleFileName(name: string): string {
  return name.split(/[\\/]/).at(-1) ?? name;
}

function summaryValue(artifact: Artifact, keys: string[]): string | null {
  for (const key of keys) {
    const value = primitive(
      key
        .split('.')
        .reduce<unknown>((current, segment) => record(current)?.[segment], artifact.summary),
    );
    if (value) return value;
  }
  return null;
}

function KpiStrip({ artifacts }: { artifacts: Artifact[] }) {
  const values: Array<{ label: string; value: string; tone?: 'attention' | 'neutral' }> = [];
  const qualityArtifacts = artifacts.filter((artifact) => /quality/i.test(artifact.artifactType));
  const forecastArtifacts = artifacts.filter((artifact) =>
    /forecast|evaluation|model/i.test(artifact.artifactType),
  );
  const parsed = artifacts.find((artifact) => /dataset|parsing|parse/i.test(artifact.artifactType));
  const processed = artifacts.find((artifact) => /processing|process/i.test(artifact.artifactType));
  const addSummaryValue = (label: string, artifact: Artifact | undefined, keys: string[]) => {
    const value = artifact && summaryValue(artifact, keys);
    if (value && !values.some((item) => item.label === label)) values.push({ label, value });
  };
  const addArtifactMetric = (
    label: string,
    candidates: Artifact[],
    keys: string[],
    digits: number,
    suffix = '',
  ) => {
    const value = candidates
      .map((artifact) => summaryValue(artifact, keys))
      .find((candidate): candidate is string => Boolean(candidate));
    if (!value || values.some((item) => item.label === label)) return;
    const numericValue = Number(value);
    values.push({
      label,
      value: Number.isFinite(numericValue) ? `${numericValue.toFixed(digits)}${suffix}` : value,
    });
  };

  addArtifactMetric('质量评分', qualityArtifacts, ['overall_score'], 1);
  addArtifactMetric(
    'CVRMSE',
    forecastArtifacts,
    ['cvrmse_percent', 'metrics.test.cvrmse_percent', 'metrics.cvrmse_percent'],
    1,
    '%',
  );
  addArtifactMetric('RMSE', forecastArtifacts, ['rmse', 'metrics.test.rmse'], 1);
  addArtifactMetric('MAE', forecastArtifacts, ['mae', 'metrics.test.mae'], 1);
  addArtifactMetric('R²', forecastArtifacts, ['r2', 'metrics.test.r2'], 2);
  addSummaryValue('解析记录', parsed, ['record_count', 'row_count', 'parsed_rows', 'valid_rows']);
  addSummaryValue('数据源数', parsed, ['source_count', 'source_files', 'file_count']);
  addSummaryValue('处理记录', processed, ['processed_rows', 'output_rows', 'valid_rows']);
  addSummaryValue('特征数', processed, ['feature_count', 'features_count']);
  addSummaryValue('缺口率', processed, ['missing_rate', 'quality.missing_rate']);
  const warningCount = artifacts.reduce((sum, artifact) => sum + artifact.warnings.length, 0);
  if (warningCount > 0)
    values.push({ label: '需要关注', value: String(warningCount), tone: 'attention' });
  if (values.length === 0) return null;
  return (
    <dl className="result-kpi-strip">
      {values.map((item) => (
        <div className={item.tone ? `kpi-${item.tone}` : undefined} key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Overview({
  turn,
  results,
  artifacts,
}: {
  turn: SessionDetail['turns'][number] | undefined;
  results: ResultReference[];
  artifacts: Artifact[];
}) {
  const conclusion = artifacts
    .map((artifact) => summaryValue(artifact, ['conclusion', 'overview', 'message']))
    .find((value): value is string => Boolean(value));
  return (
    <div className="result-overview">
      <section className="result-conclusion">
        <h3>结论</h3>
        <p>{conclusion ?? results[0]?.summary ?? '结果已登记，正在等待可验证摘要。'}</p>
      </section>
      <KpiStrip artifacts={artifacts} />
      {!turn && (
        <div className="result-unavailable" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>当前结果对应的执行记录尚未恢复。</span>
        </div>
      )}
    </div>
  );
}

function ResultEvidence({ artifacts }: { artifacts: Artifact[] }) {
  const rows = artifacts.flatMap((artifact) => artifact.files.map((file) => ({ artifact, file })));
  const importantReportRows = rows.filter(
    ({ artifact, file }) => artifact.artifactType === 'building-energy.report' && file.role.toLowerCase() === 'report',
  );
  const importantReportIds = new Set(importantReportRows.map(({ file }) => file.id));
  const supportingRows = rows.filter(({ file }) => !importantReportIds.has(file.id));
  const reportPreviewRows = importantReportRows.filter(
    ({ artifact, file }) =>
      artifact.artifactType === 'building-energy.report' &&
      file.role.toLowerCase() === 'report' &&
      file.mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html' &&
      controlledContentUrl(file.contentUrl) !== null,
  );
  const renderFileRow = ({ artifact, file }: (typeof rows)[number]) => (
    <li key={file.id}>
      <FileText size={17} aria-hidden="true" />
      <span>
        <strong>{visibleFileName(file.name)}</strong>
        <small>
          {artifactDisplayName(artifact.artifactType)} · {fileRoleDisplayName(file.role)} ·{' '}
          {formatBytes(file.sizeBytes)}
        </small>
      </span>
      {artifact.status === 'integrity_failed' ? (
        <em>完整性失败</em>
      ) : controlledContentUrl(file.contentUrl) ? (
        <a
          href={controlledContentUrl(file.contentUrl) ?? undefined}
          download={visibleFileName(file.name)}
          aria-label={`下载 ${visibleFileName(file.name)}`}
        >
          下载
        </a>
      ) : (
        <em>文件地址不可用</em>
      )}
    </li>
  );
  return (
    <section className="result-evidence" aria-labelledby="result-evidence-title">
      <header>
        <div>
          <h3 id="result-evidence-title">报告与结果文件</h3>
        </div>
      </header>
      {importantReportRows.length > 0 && (
        <>
          <div className="result-featured-heading">
            <div>
              <span className="result-section-label">重要产物</span>
              <h4 id="result-featured-reports-title">专业分析报告</h4>
            </div>
            <span>{importantReportRows.length} 个文件</span>
          </div>
          <ul
            className="result-evidence-list result-evidence-list-featured"
            aria-labelledby="result-featured-reports-title"
          >
            {importantReportRows.map(renderFileRow)}
          </ul>
        </>
      )}
      {reportPreviewRows.length > 0 && (
        <div className="report-preview-list" aria-label="专业分析报告预览">
          {reportPreviewRows.map(({ artifact, file }) => {
            const contentUrl = controlledContentUrl(file.contentUrl);
            if (!contentUrl) return null;
            return (
              <details className="report-preview" key={`preview-${file.id}`} open>
                <summary>预览专业分析报告</summary>
                <iframe
                  title={`${artifactDisplayName(artifact.artifactType)}预览`}
                  src={contentUrl}
                  sandbox=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              </details>
            );
          })}
        </div>
      )}
      {supportingRows.length > 0 && (
        <>
          {importantReportRows.length > 0 && (
            <div className="result-supporting-heading">
              <h4 id="result-supporting-files-title">其他结果文件</h4>
            </div>
          )}
          <ul
            className="result-evidence-list"
            aria-labelledby={importantReportRows.length > 0 ? 'result-supporting-files-title' : undefined}
          >
            {supportingRows.map(renderFileRow)}
          </ul>
        </>
      )}
      {rows.length === 0 && (
        <div className="result-unavailable" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>当前结果没有已发布的报告或受控文件。</span>
        </div>
      )}
    </section>
  );
}

export function ResultDetailsPanel({
  session,
  turnId,
  artifactId,
  onClose,
}: {
  session: SessionDetail;
  turnId: string;
  artifactId: string;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>('overview');
  const turn = session.turns.find((candidate) => candidate.id === turnId);
  const results = turn?.results ?? [];
  const artifacts = results
    .map((result) => session.artifacts.find((artifact) => artifact.id === result.artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
  const selected = results.find((result) => result.artifactId === artifactId) ?? results[0];
  const hasQuality = results.some((result) => result.kind === 'quality');
  const hasForecast = results.some((result) => result.kind === 'forecast');
  const tabs = useMemo(() => {
    const next: Array<{ id: ResultTab; label: string }> = [
      { id: 'overview', label: hasQuality && hasForecast ? '综合总览' : '结果总览' },
    ];
    if (hasQuality) next.push({ id: 'quality', label: '数据质量' });
    if (hasForecast) next.push({ id: 'forecast', label: '负荷预测' });
    next.push({ id: 'files', label: '报告与文件' });
    return next;
  }, [hasForecast, hasQuality]);

  useEffect(() => {
    setActiveTab('overview');
  }, [artifactId, turnId]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab('overview');
  }, [activeTab, tabs]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.focus();
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const qualityArtifacts = artifacts.filter((artifact) => /quality/i.test(artifact.artifactType));
  const forecastArtifacts = artifacts.filter((artifact) =>
    /forecast|evaluation|model/i.test(artifact.artifactType),
  );
  const panelTitle =
    hasQuality && hasForecast
      ? '综合分析结果'
      : selected?.kind === 'generic' && selected.artifactType
        ? artifactDisplayName(selected.artifactType)
        : (selected?.title ?? '结果详情');

  return (
    <div
      className="modal-backdrop result-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="result-dialog result-details-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="result-details-title"
        ref={dialogRef}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="result-dialog-header result-details-header">
          <div className="result-details-title">
            <span className="section-kicker">专业结果详情</span>
            <h2 id="result-details-title">{panelTitle}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭结果详情" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <div className="result-dialog-body result-details-body">
          <nav className="result-tabs" aria-label="结果详情分类" role="tablist">
            {tabs.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={activeTab === tab.id ? 'active' : undefined}
                aria-selected={activeTab === tab.id}
                aria-controls={`result-tab-panel-${tab.id}`}
                id={`result-tab-button-${tab.id}`}
                role="tab"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div
            className="result-tab-content"
            id={`result-tab-panel-${activeTab}`}
            aria-labelledby={`result-tab-button-${activeTab}`}
            role="tabpanel"
            tabIndex={0}
          >
            {activeTab === 'overview' && (
              <Overview turn={turn} results={results} artifacts={artifacts} />
            )}
            {activeTab === 'quality' && (
              <div className="result-tab-stack">
                {qualityArtifacts.length > 0 ? (
                  qualityArtifacts.map((artifact) => (
                    <QualityResult artifact={artifact} key={artifact.id} />
                  ))
                ) : (
                  <p className="result-unavailable">没有可展示的数据质量 Artifact。</p>
                )}
              </div>
            )}
            {activeTab === 'forecast' && (
              <div className="result-tab-stack">
                {forecastArtifacts.length > 0 ? (
                  forecastArtifacts.map((artifact) => (
                    <ForecastResult artifact={artifact} key={artifact.id} />
                  ))
                ) : (
                  <p className="result-unavailable">没有可展示的负荷预测 Artifact。</p>
                )}
              </div>
            )}
            {activeTab === 'files' && (
              <div className="result-tab-stack">
                <ResultEvidence artifacts={artifacts} />
              </div>
            )}
          </div>

        </div>
      </section>
    </div>
  );
}
