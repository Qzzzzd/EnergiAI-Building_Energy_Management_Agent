import {
  Activity,
  CalendarRange,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSpreadsheet,
  Grid2X2,
  Sparkles,
  Timer,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ResultReference, SessionDetail, TurnView } from '../domain';
import { buildTaskPlan } from '../domain/plans';
import { formatBytes } from '../ui/format';

const activeTurnStatuses = new Set(['queued', 'running', 'needs_input', 'cancelling']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryValue(
  summary: Record<string, unknown>,
  keys: string[],
): string | number | undefined {
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function summaryString(summary: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function formatSummaryValue(value: string | number): string {
  return typeof value === 'number' ? new Intl.NumberFormat('zh-CN').format(value) : value;
}

function formatGranularity(value: string | number): string {
  if (typeof value === 'number') return `${formatSummaryValue(value)} 秒`;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'mixed') return '多种';
  if (/[\/,]/.test(normalized)) {
    return normalized
      .split(/[\/,]/)
      .map((part) => formatGranularity(part.trim()))
      .join('、');
  }
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|min|mins|minute|minutes|h|hr|hour|hours)$/);
  if (!match) return value;
  const amount = match[1];
  const unit = match[2] ?? '';
  if (unit.startsWith('h')) return `${amount} 小时`;
  if (unit.startsWith('min')) return `${amount} 分钟`;
  return `${amount} 秒`;
}

function formatSummaryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function visibleFileName(name: string): string {
  return name.split(/[\\/]/).at(-1) ?? name;
}

function resultKindLabel(kind: ResultReference['kind']): string {
  if (kind === 'quality') return '数据质量';
  if (kind === 'forecast') return '负荷预测';
  return '综合分析';
}

function datasetArtifact(session: SessionDetail) {
  return [...session.artifacts]
    .reverse()
    .find(
      (artifact) =>
        artifact.artifactType === 'DatasetBundle' &&
        (artifact.status === 'succeeded' || artifact.status === 'partial'),
    );
}

function datasetFacts(summary: Record<string, unknown>) {
  const recordCount = summaryValue(summary, ['record_count']);
  const pointCount = summaryValue(summary, ['point_count']);
  const worksheetCount = summaryValue(summary, ['successful_worksheet_count', 'worksheet_count']);
  const samplingSource = isRecord(summary.sampling) ? summary.sampling : summary;
  const sampling =
    summaryValue(samplingSource, [
      'data_granularity',
      'detected_granularity',
      'granularity',
      'sampling_granularity',
      'sampling_interval',
      'sampling_interval_seconds',
      'expected_interval_seconds',
    ]) ?? '未识别';
  const timeRange = isRecord(summary.time_range) ? summary.time_range : summary;
  const timeStart = summaryString(timeRange, ['time_start', 'start_at', 'start']);
  const timeEnd = summaryString(timeRange, ['time_end', 'end_at', 'end']);

  const stats = [
    recordCount === undefined
      ? undefined
      : { label: '记录', value: formatSummaryValue(recordCount), Icon: Database },
    pointCount === undefined
      ? undefined
      : { label: '点位', value: formatSummaryValue(pointCount), Icon: Waves },
    worksheetCount === undefined
      ? undefined
      : { label: '工作表', value: formatSummaryValue(worksheetCount), Icon: Grid2X2 },
    {
      label: '时间粒度',
      value: formatGranularity(sampling),
      Icon: Timer,
    },
  ].filter(
    (fact): fact is { label: string; value: string; Icon: LucideIcon } => fact !== undefined,
  );
  const range = [
    timeStart ? formatSummaryTime(timeStart) : '',
    timeEnd ? formatSummaryTime(timeEnd) : '',
  ]
    .filter(Boolean)
    .join(' — ');
  return { stats, range: range || undefined };
}

function hasWorkflow(session: SessionDetail, turn: TurnView): boolean {
  return (
    Boolean(turn.executionPlan) ||
    session.skillJobs.some((job) => job.turnId === turn.id) ||
    turn.activities.some((activity) => activity.kind === 'plan' || activity.kind === 'skill')
  );
}

function workflowTitle(session: SessionDetail, turn: TurnView): string {
  const plan = buildTaskPlan(turn, session.skillJobs);
  if (turn.executionPlan?.title) return turn.executionPlan.title;
  const skillNames = new Set(plan.nodes.map((node) => node.skillName));
  const quality = skillNames.has('building-energy-data-quality');
  const forecast = skillNames.has('building-energy-load-forecasting');
  const report = skillNames.has('building-energy-report-generation');
  if (quality && forecast) return '质量评估 + 负荷预测';
  if (quality) return '数据质量评估';
  if (forecast) return '负荷预测';
  if (report) return '专业报表生成';
  return '建筑能源分析';
}

function currentStage(session: SessionDetail, turn: TurnView, workflow: boolean): string {
  if (turn.status === 'needs_input') return '等待确认';
  if (!workflow) return turn.status === 'cancelling' ? '正在停止回复' : '正在思考';
  const node = buildTaskPlan(turn, session.skillJobs).currentNode;
  if (node?.stage) return node.stage;
  if (node?.displayName) return node.displayName;
  return turn.status === 'cancelling' ? '正在取消任务' : '任务运行中';
}

function progressPercent(session: SessionDetail, turn: TurnView): number | null {
  const planProgress = buildTaskPlan(turn, session.skillJobs).currentNode?.progress;
  const activityProgress = [...turn.activities]
    .reverse()
    .find((activity) => activity.progress)?.progress;
  const progress = planProgress ?? activityProgress;
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.completed / progress.total) * 100)));
}

function DataContext({ session }: { session: SessionDetail | null }) {
  const artifact = session ? datasetArtifact(session) : undefined;
  const summary = artifact ? datasetFacts(artifact.summary) : undefined;
  const uploads = session?.uploads ?? [];
  return (
    <section className="context-section" data-context-section="input">
      <header className="context-section-header">
        <Database size={17} aria-hidden="true" />
        <h2>当前文件组</h2>
      </header>
      {uploads.length > 0 ? (
        <>
          <div className="context-files" aria-label="当前文件组">
            {uploads.map((upload) => (
              <article key={upload.id}>
                <FileSpreadsheet size={17} aria-hidden="true" />
                <span>
                  <strong>{visibleFileName(upload.name)}</strong>
                  <small>{formatBytes(upload.sizeBytes)} · 已上传</small>
                </span>
                <CheckCircle2 size={15} aria-label="文件已就绪" />
              </article>
            ))}
          </div>
          {summary && (summary.stats.length > 0 || summary.range) && (
            <section className="data-summary" aria-labelledby="data-summary-title">
              <div className="data-summary-heading">
                <span id="data-summary-title">数据摘要</span>
              </div>
              {summary.stats.length > 0 && (
                <dl className="context-data-facts data-summary-stats">
                  {summary.stats.map(({ Icon, ...fact }) => (
                    <div key={fact.label}>
                      <Icon size={15} aria-hidden="true" />
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {summary.range && (
                <div className="data-summary-range">
                  <CalendarRange size={15} aria-hidden="true" />
                  <span>
                    <small>数据时间范围</small>
                    <strong>{summary.range}</strong>
                  </span>
                </div>
              )}
            </section>
          )}
        </>
      ) : (
        <div className="context-empty">
          <FileSpreadsheet size={22} aria-hidden="true" />
          <p>还没有数据文件</p>
          <span>在消息中添加 CSV 或 Excel 文件</span>
        </div>
      )}
    </section>
  );
}

function TaskContext({
  session,
  busy,
  onCancel,
}: {
  session: SessionDetail | null;
  busy: boolean;
  onCancel?: () => void;
}) {
  const latestTurn = session?.turns.at(-1);
  const activeTurn =
    latestTurn && activeTurnStatuses.has(latestTurn.status) ? latestTurn : undefined;
  const workflow = Boolean(session && activeTurn && hasWorkflow(session, activeTurn));
  const progress = session && activeTurn ? progressPercent(session, activeTurn) : null;
  const indeterminate =
    progress !== null &&
    Boolean(
      activeTurn &&
        ['queued', 'running', 'cancelling'].includes(activeTurn.status) &&
        (progress === 0 || progress === 100),
    );
  return (
    <section className="context-section" data-context-section="task">
      <header className="context-section-header">
        <Activity size={17} aria-hidden="true" />
        <h2>任务状态</h2>
      </header>
      {session && activeTurn ? (
        <div className="active-task">
          <span className="active-task-label">
            {workflow ? workflowTitle(session, activeTurn) : '普通对话'}
          </span>
          <strong>{currentStage(session, activeTurn, workflow)}</strong>
          {indeterminate ? (
            <div className="right-progress right-progress-indeterminate">
              <span aria-hidden="true" />
              <span>进行中</span>
            </div>
          ) : progress !== null ? (
            <div className="right-progress">
              <progress max="100" value={progress} aria-label="当前任务进度" />
              <span>{progress}%</span>
            </div>
          ) : (
            <span className="right-uncertain">
              <span aria-hidden="true" />
              进度由任务状态更新
            </span>
          )}
          {onCancel && !session.archived && (
            <button
              className="cancel-action context-cancel-action"
              type="button"
              disabled={busy || activeTurn.status === 'cancelling'}
              onClick={onCancel}
            >
              <X size={14} aria-hidden="true" />
              {activeTurn.status === 'cancelling'
                ? '正在取消'
                : workflow
                  ? '取消当前任务'
                  : '停止当前回复'}
            </button>
          )}
        </div>
      ) : (
        <div className="context-empty compact">
          <CheckCircle2 size={22} aria-hidden="true" />
          <p>当前没有运行中的任务</p>
        </div>
      )}
    </section>
  );
}

type ResultBusinessKind = 'combined' | 'quality' | 'forecast' | 'report' | 'generic';

interface ResultCandidate {
  turnId: string;
  result: ResultReference;
}

function isCombinedArtifact(result: ResultReference): boolean {
  return /combined|integrated/i.test(result.artifactType ?? '');
}

function isBusinessResult(result: ResultReference): boolean {
  return resultBusinessKind(result) !== 'generic';
}

function resultBusinessKind(result: ResultReference): ResultBusinessKind {
  if (isCombinedArtifact(result)) return 'combined';
  if (result.kind === 'quality' || /quality/i.test(result.artifactType ?? '')) {
    return 'quality';
  }
  if (result.kind === 'forecast' || /forecast|evaluation|model/i.test(result.artifactType ?? '')) {
    return 'forecast';
  }
  if (/building-energy\.report|report-generation|reportbundle/i.test(result.artifactType ?? '')) {
    return 'report';
  }
  return 'generic';
}

function forecastArtifactRank(result: ResultReference): number {
  const artifactType = result.artifactType ?? '';
  if (/forecast/i.test(artifactType)) return 3;
  if (/evaluation/i.test(artifactType)) return 2;
  if (/model/i.test(artifactType)) return 1;
  return 0;
}

function isUsableResult(result: ResultReference): boolean {
  return (
    typeof result.artifactId === 'string' &&
    result.artifactId.trim().length > 0 &&
    (result.status === 'succeeded' || result.status === 'partial')
  );
}

function visibleResults(session: SessionDetail | null) {
  if (!session) return [];

  // Turns are returned oldest-first. Walking them backwards lets the first
  // reference for an artifact be the newest valid reference in the session.
  const seenArtifactIds = new Set<string>();
  const visible: ResultCandidate[] = [];

  for (let turnIndex = session.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = session.turns[turnIndex];
    if (!turn || typeof turn.id !== 'string' || !turn.id) continue;

    const candidates: ResultCandidate[] = [];
    const results = Array.isArray(turn.results) ? turn.results : [];
    for (let resultIndex = results.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = results[resultIndex];
      if (
        !result ||
        !isUsableResult(result) ||
        !isBusinessResult(result) ||
        seenArtifactIds.has(result.artifactId)
      ) {
        continue;
      }
      seenArtifactIds.add(result.artifactId);
      candidates.push({ turnId: turn.id, result });
    }

    if (candidates.length === 0) continue;

    // A true Combined/Integrated artifact is the single entry for this turn;
    // the turn's quality/forecast refs remain available in the detail panel.
    const combined = candidates.find(({ result }) => isCombinedArtifact(result));
    if (combined) {
      visible.push(combined);
      continue;
    }

    const byKind = new Map<ResultBusinessKind, ResultCandidate>();
    for (const candidate of candidates) {
      const kind = resultBusinessKind(candidate.result);
      const previous = byKind.get(kind);
      if (
        kind === 'forecast' &&
        previous &&
        forecastArtifactRank(candidate.result) > forecastArtifactRank(previous.result)
      ) {
        byKind.set(kind, candidate);
      } else if (!previous) {
        byKind.set(kind, candidate);
      }
    }
    visible.push(...byKind.values());
  }

  return visible;
}

export function ActivityInspector({
  session,
  busy = false,
  onCancel,
  onOpenResult,
}: {
  session: SessionDetail | null;
  busy?: boolean;
  onCancel?: () => void;
  onOpenResult?: (turnId: string, artifactId: string) => void;
}) {
  const results = visibleResults(session);
  return (
    <div className="activity-inspector-content right-panel-content">
      <div className="context-panel-title">
        <strong>工作上下文</strong>
      </div>

      <DataContext session={session} />
      <TaskContext session={session} busy={busy} {...(onCancel ? { onCancel } : {})} />

      <section className="context-section results-section" data-context-section="results">
        <header className="context-section-header">
          <Sparkles size={17} aria-hidden="true" />
          <h2>结果清单</h2>
          <span>{results.length}</span>
        </header>
        {results.length > 0 ? (
          <div className="result-list">
            {results.map(({ turnId, result }) => (
              <button
                type="button"
                key={`${turnId}-${result.artifactId}`}
                aria-label={`查看 ${result.title} 的专业详情`}
                onClick={() => onOpenResult?.(turnId, result.artifactId)}
              >
                <span className={`result-type result-${result.kind}`}>
                  {resultKindLabel(result.kind)}
                </span>
                <strong>{result.title}</strong>
                <small>{result.summary}</small>
                <span className="result-link">
                  查看专业详情
                  <ChevronRight size={15} aria-hidden="true" />
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="context-empty">
            <Sparkles size={22} aria-hidden="true" />
            <p>结果将在这里汇总</p>
            <span>完成任务后可查看指标、图表和文件</span>
          </div>
        )}
      </section>
    </div>
  );
}
