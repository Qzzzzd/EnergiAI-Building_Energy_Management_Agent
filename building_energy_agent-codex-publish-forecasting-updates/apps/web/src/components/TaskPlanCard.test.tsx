import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillJobView, TurnView } from '../domain';
import { TaskPlanCard } from './TaskPlanCard';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const now = '2026-08-10T01:00:00.000Z';

const jobs: SkillJobView[] = [
  {
    turnId: 'turn-integrated',
    skillName: 'building-energy-data-parsing',
    jobId: 'job-parse',
    status: 'succeeded',
    resultRefs: [
      {
        artifactId: 'artifact-parse',
        artifactType: 'DatasetBundle',
        status: 'succeeded',
        manifestUrl: '/api/v1/artifacts/artifact-parse',
      },
    ],
    warnings: [],
  },
  {
    turnId: 'turn-integrated',
    skillName: 'building-energy-data-processing',
    jobId: 'job-process',
    status: 'running',
    stage: '处理缺口',
    progress: { completed: 2, total: 4, unit: '文件' },
    warnings: [],
  },
  {
    turnId: 'turn-integrated',
    skillName: 'building-energy-data-quality',
    jobId: 'job-quality',
    status: 'partial',
    warnings: ['DQ4 无法计算：缺少语义映射。'],
  },
  {
    turnId: 'turn-integrated',
    skillName: 'building-energy-load-forecasting',
    jobId: 'job-forecast',
    status: 'queued',
    warnings: [],
  },
];

const turn: TurnView = {
  id: 'turn-integrated',
  status: 'running',
  startedAt: now,
  messages: [],
  activities: [],
  executionPlan: {
    planId: 'plan-integrated',
    title: '综合能源分析',
    nodes: [
      {
        id: 'node-parse',
        title: '解析输入数据',
        skillName: 'building-energy-data-parsing',
        dependsOn: [],
      },
      {
        id: 'node-process',
        title: '处理预测数据',
        skillName: 'building-energy-data-processing',
        dependsOn: ['node-parse'],
      },
      {
        id: 'node-quality',
        title: '评估数据质量',
        skillName: 'building-energy-data-quality',
        dependsOn: ['node-process'],
        parallelGroup: 'result-analysis',
      },
      {
        id: 'node-forecast',
        title: '生成负荷预测',
        skillName: 'building-energy-load-forecasting',
        dependsOn: ['node-process'],
        parallelGroup: 'result-analysis',
      },
    ],
  },
  results: [],
};

describe('TaskPlanCard', () => {
  it('renders the Agent-declared nodes, dependencies, and parallel branch', () => {
    render(<TaskPlanCard turn={turn} jobs={jobs} />);

    expect(screen.getByText('建筑能源数据解析')).toBeVisible();
    expect(screen.getByText('建筑能源预测数据处理')).toBeVisible();
    expect(screen.getByText('建筑能源数据质量评估')).toBeVisible();
    expect(screen.getByText('建筑能源负荷预测')).toBeVisible();
    expect(screen.getByText('质量分支')).toBeVisible();
    expect(screen.getByText('预测分支')).toBeVisible();
    expect(screen.getAllByText('依赖：建筑能源预测数据处理')).toHaveLength(2);
    expect(screen.getAllByText('50%')).toHaveLength(2);
    expect(screen.getByText('已产出 1 项结果')).toBeVisible();
    expect(screen.queryByText('building-energy-load-forecasting')).not.toBeInTheDocument();
    expect(screen.queryByText('result-analysis')).not.toBeInTheDocument();
  });

  it('keeps partial results visible and offers rerun only for terminal turns', () => {
    const partialTurn: TurnView = { ...turn, status: 'partial', finishedAt: now };
    const rerun = () => undefined;

    render(<TaskPlanCard turn={partialTurn} jobs={jobs} onRerun={rerun} />);

    expect(screen.getAllByText('部分完成').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: '重新运行' })).toBeVisible();
    expect(screen.getByText(/质量分支：部分完成；预测分支：部分完成/)).toBeVisible();
  });

  it('keeps needs_input and failed node states truthful when the turn is terminal or paused', () => {
    const needsInputTurn: TurnView = { ...turn, status: 'needs_input' };
    render(<TaskPlanCard turn={needsInputTurn} jobs={[{ ...jobs[1]!, status: 'running' }]} />);

    expect(screen.getAllByText(/需要确认/).length).toBeGreaterThan(0);
    expect(screen.getByText('需要确认：建筑能源预测数据处理')).toBeVisible();

    cleanup();
    const failedTurn: TurnView = { ...turn, status: 'failed', finishedAt: now };
    render(<TaskPlanCard turn={failedTurn} jobs={[{ ...jobs[1]!, status: 'running' }]} />);

    expect(screen.getAllByText(/失败/).length).toBeGreaterThan(0);
    expect(screen.queryByText('等待')).not.toBeInTheDocument();
  });

  it('shows a resumed skill as running while its command is ahead of the queued job event', () => {
    const resumedJobs = jobs.map((job) => {
      if (job.skillName === 'building-energy-data-processing')
        return { ...job, status: 'succeeded' as const };
      if (job.skillName === 'building-energy-data-quality') {
        return { ...job, status: 'queued' as const, stage: 'queued' };
      }
      return { ...job, status: 'queued' as const };
    });
    const resumedTurn: TurnView = {
      ...turn,
      activities: [
        {
          id: 'command-quality-resume',
          turnId: turn.id,
          kind: 'command',
          title: 'skill-run resume --skill building-energy-data-quality',
          status: 'running',
        },
      ],
    };

    render(<TaskPlanCard turn={resumedTurn} jobs={resumedJobs} />);

    expect(screen.getByText('正在执行：建筑能源数据质量评估')).toBeVisible();
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0);
    expect(screen.queryByText('等待前置步骤：建筑能源数据质量评估')).not.toBeInTheDocument();
  });

  it.each(['cancelled', 'interrupted'] as const)('stops live animation for %s terminal turns', (status) => {
    vi.useFakeTimers();
    const terminalTurn: TurnView = { ...turn, status, finishedAt: now };
    const { container } = render(
      <TaskPlanCard turn={terminalTurn} jobs={[{ ...jobs[1]!, status: 'running' }]} />,
    );

    expect(screen.getAllByText(status === 'cancelled' ? '已取消' : '已中断').length).toBeGreaterThan(0);
    expect(container.querySelector('.spin')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });
});
