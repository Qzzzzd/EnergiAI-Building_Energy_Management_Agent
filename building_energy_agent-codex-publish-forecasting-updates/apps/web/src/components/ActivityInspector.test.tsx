import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultReference, SessionDetail, TurnView } from '../domain';
import { ActivityInspector } from './ActivityInspector';

afterEach(cleanup);

const resultNow = '2026-08-10T01:00:00.000Z';

function resultReference(
  artifactId: string,
  artifactType: string | undefined,
  kind: ResultReference['kind'],
  overrides: Partial<Pick<ResultReference, 'title' | 'summary' | 'status'>> = {},
): ResultReference {
  return {
    artifactId,
    ...(artifactType ? { artifactType } : {}),
    title: overrides.title ?? `${kind} 结果`,
    kind,
    status: overrides.status ?? 'succeeded',
    summary: overrides.summary ?? '真实结果',
  };
}

function resultTurn(
  id: string,
  results: ResultReference[],
  status: TurnView['status'] = 'completed',
): TurnView {
  return {
    id,
    status,
    startedAt: resultNow,
    messages: [],
    activities: [],
    results,
  };
}

function resultSession(turns: TurnView[]): SessionDetail {
  return {
    id: 'result-session',
    title: '结果去重',
    status: 'completed',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    modelLocked: true,
    archived: false,
    updatedAt: resultNow,
    preview: '',
    createdAt: resultNow,
    lastEventId: 1,
    turns,
    uploads: [],
    artifacts: [],
    skillJobs: [],
    disclosure: '本地删除边界说明',
  };
}

describe('ActivityInspector', () => {
  it('shows the latest resumed turn instead of a historical needs-input turn', () => {
    const now = '2026-08-10T01:00:00.000Z';
    const session: SessionDetail = {
      id: 'session-1',
      title: '恢复验收',
      status: 'completed',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      modelLocked: true,
      archived: false,
      updatedAt: now,
      preview: '',
      createdAt: now,
      lastEventId: 6,
      skillJobs: [],
      turns: [
        {
          id: 'turn-1',
          status: 'needs_input',
          startedAt: now,
          messages: [],
          activities: [
            { id: 'old', turnId: 'turn-1', kind: 'agent', title: '旧 Turn', status: 'running' },
          ],
          results: [],
        },
        {
          id: 'turn-2',
          status: 'completed',
          startedAt: now,
          messages: [],
          activities: [
            {
              id: 'new',
              turnId: 'turn-2',
              kind: 'skill',
              title: 'Codex Turn',
              status: 'completed',
              skillName: 'building-energy-data-parsing',
              stage: '输入快照已就绪',
              progress: { completed: 1, total: 1, unit: '文件' },
              model: 'gpt-5.6-sol',
              reasoning: 'xhigh',
              tokens: { input: 120, cached: 80, output: 24 },
            },
          ],
          results: [],
        },
      ],
      uploads: [],
      artifacts: [],
      disclosure: '本地删除边界说明',
    };

    render(<ActivityInspector session={session} />);

    expect(screen.getByText('当前没有运行中的任务')).toBeVisible();
    expect(screen.queryByText(/技术详情/)).not.toBeInTheDocument();
    expect(screen.queryByText(/进度 1\/1 文件/)).not.toBeInTheDocument();
    expect(screen.queryByText(/token 120 in.*80 cached.*24 out/)).not.toBeInTheDocument();
    expect(screen.queryByText('旧 Turn')).not.toBeInTheDocument();
  });

  it('shows only verified DatasetBundle summary fields in the fixed business order', () => {
    const now = '2026-08-10T01:00:00.000Z';
    const session: SessionDetail = {
      id: 'session-2',
      title: '右栏业务上下文',
      status: 'running',
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
      modelLocked: true,
      archived: false,
      updatedAt: now,
      preview: '',
      createdAt: now,
      lastEventId: 8,
      skillJobs: [],
      turns: [
        {
          id: 'turn-running',
          status: 'running',
          startedAt: now,
          messages: [],
          activities: [],
          results: [],
        },
      ],
      uploads: [
        {
          id: 'source-1',
          sourceRef: 'src:source-1',
          name: '用户上传文件.xlsx',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
      artifacts: [
        {
          id: 'dataset-1',
          turnId: 'turn-running',
          artifactType: 'DatasetBundle',
          status: 'succeeded',
          producer: { skillName: 'building-energy-data-parsing', jobId: 'job-1' },
          summary: {
            record_count: 216131,
            point_count: 9,
            successful_worksheet_count: 9,
            time_range: {
              time_start: '2025-05-31T16:00:00+00:00',
              time_end: '2025-06-20T15:59:00+00:00',
            },
          },
          warnings: [],
          files: [],
        },
      ],
      disclosure: '本地删除边界说明',
    };
    const onCancel = vi.fn();
    const { container } = render(<ActivityInspector session={session} onCancel={onCancel} />);

    expect(screen.getByText('216,131')).toBeVisible();
    expect(screen.getAllByText('9')).toHaveLength(2);
    const range = container.querySelector('.data-summary-range');
    expect(range).toHaveTextContent('2025/06/01 00:00');
    expect(range).toHaveTextContent('2025/06/20 23:59');
    expect(screen.getByText('用户上传文件.xlsx')).toBeVisible();
    expect(screen.queryByText('采样粒度')).not.toBeInTheDocument();
    expect(screen.queryByText('同步游标')).not.toBeInTheDocument();
    expect(screen.queryByText('job-1')).not.toBeInTheDocument();

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-context-section]')).map(
        (section) => section.dataset.contextSection,
      ),
    ).toEqual(['input', 'task', 'results']);

    fireEvent.click(screen.getByRole('button', { name: '停止当前回复' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('gpt-5.6-sol')).not.toBeInTheDocument();
  });

  it('omits absent DatasetBundle summary fields and keeps the cancel action out of terminal turns', () => {
    const now = '2026-08-10T01:00:00.000Z';
    const session: SessionDetail = {
      id: 'session-3',
      title: '摘要缺失字段',
      status: 'completed',
      model: null,
      reasoning: null,
      modelLocked: false,
      archived: false,
      updatedAt: now,
      preview: '',
      createdAt: now,
      lastEventId: 1,
      skillJobs: [],
      turns: [
        {
          id: 'turn-complete',
          status: 'completed',
          startedAt: now,
          messages: [],
          activities: [],
          results: [],
        },
      ],
      uploads: [
        {
          id: 'source-2',
          sourceRef: 'src:source-2',
          name: '摘要缺失字段.xlsx',
          sizeBytes: 1024,
          sha256: 'b'.repeat(64),
          mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
      artifacts: [
        {
          id: 'dataset-2',
          turnId: 'turn-complete',
          artifactType: 'DatasetBundle',
          status: 'succeeded',
          producer: { skillName: 'building-energy-data-parsing', jobId: 'job-2' },
          summary: { record_count: 12 },
          warnings: [],
          files: [],
        },
      ],
      disclosure: '本地删除边界说明',
    };

    render(<ActivityInspector session={session} onCancel={vi.fn()} />);

    expect(screen.getByText('12')).toBeVisible();
    expect(screen.queryByText('点位')).not.toBeInTheDocument();
    expect(screen.queryByText('工作表')).not.toBeInTheDocument();
    expect(screen.queryByText('时间范围')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
  });

  it('deduplicates a shared artifact across resumed turns and uses the newest turn', () => {
    const onOpenResult = vi.fn();
    const sharedOld = resultReference('forecast-shared', 'ForecastBundle', 'forecast', {
      title: '负荷预测结论',
      summary: '旧 Turn 引用',
    });
    const sharedNew = resultReference('forecast-shared', 'ForecastBundle', 'forecast', {
      title: '负荷预测结论',
      summary: '最新 Turn 引用',
    });

    render(
      <ActivityInspector
        session={resultSession([
          resultTurn('turn-old', [sharedOld]),
          resultTurn('turn-new', [sharedNew]),
        ])}
        onOpenResult={onOpenResult}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: /专业详情/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText('最新 Turn 引用')).toBeVisible();

    fireEvent.click(buttons[0]!);
    expect(onOpenResult).toHaveBeenCalledWith('turn-new', 'forecast-shared');
  });

  it('collapses Model, Evaluation and Forecast artifacts into one forecast entry per turn', () => {
    const onOpenResult = vi.fn();
    render(
      <ActivityInspector
        session={
          resultSession([
            resultTurn('turn-forecast', [
              resultReference('model-1', 'ModelBundle', 'forecast'),
              resultReference('evaluation-1', 'EvaluationBundle', 'forecast'),
              resultReference('forecast-1', 'ForecastBundle', 'forecast'),
            ]),
          ])
        }
        onOpenResult={onOpenResult}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: /专业详情/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(onOpenResult).toHaveBeenCalledWith('turn-forecast', 'forecast-1');
  });

  it('keeps one quality entry and one forecast entry when a turn has both branches', () => {
    render(
      <ActivityInspector
        session={
          resultSession([
            resultTurn('turn-integrated', [
              resultReference('quality-1', 'QualityAssessmentBundle', 'quality'),
              resultReference('forecast-1', 'ForecastBundle', 'forecast'),
            ]),
          ])
        }
      />,
    );

    expect(screen.getAllByRole('button', { name: /专业详情/ })).toHaveLength(2);
    expect(screen.getByText('数据质量')).toBeVisible();
    expect(screen.getByText('负荷预测')).toBeVisible();
  });

  it('prefers a real Combined or Integrated artifact for the same turn', () => {
    const onOpenResult = vi.fn();
    render(
      <ActivityInspector
        session={
          resultSession([
            resultTurn('turn-combined', [
              resultReference('quality-1', 'QualityAssessmentBundle', 'quality'),
              resultReference('forecast-1', 'ForecastBundle', 'forecast'),
              resultReference('integrated-1', 'IntegratedBundle', 'generic', {
                title: '综合分析结果',
              }),
            ]),
          ])
        }
        onOpenResult={onOpenResult}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: /专业详情/ });
    expect(buttons).toHaveLength(1);
    expect(screen.getByText('综合分析结果')).toBeVisible();
    fireEvent.click(buttons[0]!);
    expect(onOpenResult).toHaveBeenCalledWith('turn-combined', 'integrated-1');
  });

  it('keeps independent forecast artifacts from separate runs in newest-first order', () => {
    const onOpenResult = vi.fn();
    render(
      <ActivityInspector
        session={
          resultSession([
            resultTurn('turn-first', [
              resultReference('forecast-first', 'ForecastBundle', 'forecast', {
                title: '第一次预测',
              }),
            ]),
            resultTurn('turn-second', [
              resultReference('forecast-second', 'ForecastBundle', 'forecast', {
                title: '第二次预测',
              }),
            ]),
          ])
        }
        onOpenResult={onOpenResult}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: /专业详情/ });
    expect(buttons).toHaveLength(2);
    expect(screen.getByText('第二次预测')).toBeVisible();
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onOpenResult.mock.calls).toEqual([
      ['turn-second', 'forecast-second'],
      ['turn-first', 'forecast-first'],
    ]);
  });

  it('shows partial results without requiring a published Artifact', () => {
    render(
      <ActivityInspector
        session={
          resultSession([
            resultTurn('turn-partial', [
              resultReference('partial-forecast', undefined, 'forecast', {
                status: 'partial',
                summary: '部分结果，Artifact 详情仍在恢复',
              }),
            ], 'partial'),
          ])
        }
      />,
    );

    expect(screen.getAllByRole('button', { name: /专业详情/ })).toHaveLength(1);
    expect(screen.getByText('部分结果，Artifact 详情仍在恢复')).toBeVisible();
  });
});
