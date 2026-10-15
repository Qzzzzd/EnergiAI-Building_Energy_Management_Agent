import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, SessionDetail, TurnStatus } from '../domain';
import { ResultDetailsPanel } from './ResultDetailsPanel';

afterEach(cleanup);

const sha256 = 'b'.repeat(64);
const now = '2026-08-10T01:00:00.000Z';

function file(id: string, name: string, role: string, mediaType: string, contentUrl: string) {
  return { id, name, role, mediaType, sizeBytes: 512, sha256, contentUrl };
}

const artifacts: Artifact[] = [
  {
    id: 'quality-artifact',
    turnId: 'turn-integrated',
    artifactType: 'QualityAssessmentBundle',
    status: 'succeeded',
    producer: { skillName: 'building-energy-data-quality', jobId: 'job-quality' },
    summary: {
      conclusion: '数据整体可用，但存在需要修复的缺口。',
      overall_score: 88,
      dimensions: {
        DQ1: { score: 100, summary: '缺口可追踪。' },
        DQ2: { score: 78.6, summary: '异常率可控。' },
        DQ3: { score: 91.7, summary: '特征覆盖充分。' },
        DQ4: { score: 17.6, summary: '值域覆盖不足。' },
        DQ5: { score: 62.6, summary: '一致性需要关注。' },
        DQ6: { score: 73.8, summary: '信息量可用。' },
      },
      issues: [{ severity: 'warning', summary: '连续缺失', recommended_action: '补录数据' }],
      visualizations: [
        {
          chart_id: 'quality_score_overview',
          title: '六维质量评分',
          display_order: 0,
          file_name: 'quality-score.png',
          business_category: 'data_quality',
        },
      ],
    },
    warnings: ['部分质量维度不可计算。'],
    files: [
      file(
        'quality-chart',
        'quality-score.png',
        'visualization',
        'image/png',
        '/api/v1/artifacts/quality/content?file=0',
      ),
      file(
        'quality-report',
        'quality-report.md',
        'report',
        'text/markdown',
        '/api/v1/artifacts/quality/content?file=1',
      ),
    ],
  },
  {
    id: 'forecast-artifact',
    turnId: 'turn-integrated',
    artifactType: 'ForecastBundle',
    status: 'succeeded',
    producer: { skillName: 'building-energy-load-forecasting', jobId: 'job-forecast' },
    summary: {
      prediction_summary: { prediction_count: 24, valid_prediction_count: 24 },
      target_point_id: 'CHW-01',
      visualizations: [
        {
          chart_id: 'actual_vs_prediction',
          title: '实际值与预测值对比',
          display_order: 0,
          file_name: 'forecast.png',
          business_category: 'load_forecast',
        },
      ],
    },
    warnings: [],
    files: [
      file(
        'forecast-preview',
        'forecast-preview.json',
        'forecast-preview',
        'application/json',
        '/api/v1/artifacts/forecast/content?file=0',
      ),
      file(
        'forecast-chart',
        'forecast.png',
        'visualization',
        'image/png',
        '/api/v1/artifacts/forecast/content?file=1',
      ),
    ],
  },
];

const session: SessionDetail = {
  id: 'session-1',
  title: '综合分析',
  status: 'completed',
  model: 'gpt-5.6-sol',
  reasoning: 'xhigh',
  modelLocked: true,
  archived: false,
  updatedAt: now,
  preview: '综合分析',
  createdAt: now,
  lastEventId: 18,
  turns: [
    {
      id: 'turn-integrated',
      status: 'completed',
      startedAt: now,
      finishedAt: now,
      messages: [],
      activities: [],
      results: [
        {
          artifactId: 'quality-artifact',
          title: '数据质量结论',
          artifactType: 'QualityAssessmentBundle',
          manifestUrl: '/api/v1/artifacts/quality-artifact',
          kind: 'quality',
          status: 'succeeded',
          summary: '数据整体可用，但存在需要修复的缺口。',
        },
        {
          artifactId: 'forecast-artifact',
          title: '负荷预测结论',
          artifactType: 'ForecastBundle',
          manifestUrl: '/api/v1/artifacts/forecast-artifact',
          kind: 'forecast',
          status: 'succeeded',
          summary: '预测结果已发布。',
        },
      ],
    },
  ],
  uploads: [],
  artifacts,
  skillJobs: [],
  disclosure: '技术字段仅用于排障。',
};

describe('ResultDetailsPanel', () => {
  it('previews a generated report through the controlled sandbox boundary', () => {
    const reportArtifact: Artifact = {
      id: 'report-artifact',
      turnId: 'turn-integrated',
      artifactType: 'building-energy.report',
      status: 'succeeded',
      producer: { skillName: 'building-energy-report-generation', jobId: 'job-report' },
      summary: { report_type: 'integrated', title: '建筑能源综合分析报告' },
      warnings: [],
      files: [
        file(
          'report-html',
          'report.html',
          'report',
          'text/html',
          '/api/v1/artifacts/report/content?file=0',
        ),
        file(
          'report-pdf',
          'report.pdf',
          'report',
          'application/pdf',
          '/api/v1/artifacts/report/content?file=1',
        ),
      ],
    };
    const reportSession: SessionDetail = {
      ...session,
      turns: [
        {
          ...session.turns[0]!,
          results: [
            ...session.turns[0]!.results,
            {
              artifactId: 'report-artifact',
              title: '建筑能源专业分析报告',
              artifactType: 'building-energy.report',
              manifestUrl: '/api/v1/artifacts/report-artifact',
              kind: 'generic',
              status: 'succeeded',
              summary: '建筑能源综合分析报告',
            },
          ],
        },
      ],
      artifacts: [...artifacts, reportArtifact],
    };

    render(
      <ResultDetailsPanel
        session={reportSession}
        turnId="turn-integrated"
        artifactId="report-artifact"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '报告与文件' }));
    expect(screen.getByText('预览专业分析报告')).toBeVisible();
    expect(screen.getByTitle('建筑能源专业分析报告预览')).toHaveAttribute('sandbox', '');
    expect(screen.getByTitle('建筑能源专业分析报告预览')).toHaveAttribute(
      'src',
      '/api/v1/artifacts/report/content?file=0',
    );
    expect(screen.getByRole('link', { name: '下载 report.html' })).toHaveAttribute(
      'href',
      '/api/v1/artifacts/report/content?file=0',
    );
    expect(screen.getByRole('link', { name: '下载 report.pdf' })).toHaveAttribute(
      'href',
      '/api/v1/artifacts/report/content?file=1',
    );
  });

  it('switches dynamic result pages and keeps real artifact links', () => {
    render(
      <ResultDetailsPanel
        session={session}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('综合分析结果')).toBeVisible();
    expect(screen.getByRole('tab', { name: '综合总览' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '数据质量' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '负荷预测' })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '数据质量' }));
    expect(screen.getByText('六维质量评分')).toBeVisible();
    expect(screen.getByRole('img', { name: '六维质量评分雷达图' })).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '负荷预测' }));
    expect(screen.getByText('预测点数')).toBeVisible();
    expect(screen.getByAltText(/实际值与预测值对比/)).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '报告与文件' }));
    expect(screen.queryByText('数据证据')).not.toBeInTheDocument();
    expect(screen.queryByText('查看数据证据 · forecast-preview')).not.toBeInTheDocument();
    expect(screen.queryByText('数据质量图表')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '下载 quality-report.md' })).toHaveAttribute(
      'href',
      '/api/v1/artifacts/quality/content?file=1',
    );
  });

  it('does not render the removed result status card when a referenced Artifact is missing', () => {
    const partialSession: SessionDetail = {
      ...session,
      artifacts: artifacts.slice(0, 1),
    };

    render(
      <ResultDetailsPanel
        session={partialSession}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('status', { name: '结果状态' })).not.toBeInTheDocument();
  });

  it('does not render the removed data-quality chart gallery', () => {
    const unavailableSession: SessionDetail = {
      ...session,
      artifacts: [
        {
          ...artifacts[0]!,
          summary: {
            visualizations: [
              {
                chart_id: 'quality_score_overview',
                title: '六维质量评分',
                display_order: 0,
                file_name: 'quality-score.png',
                business_category: 'data_quality',
              },
            ],
          },
          files: [
            file(
              'unsafe-quality-chart',
              'quality-score.png',
              'visualization',
              'image/png',
              'https://example.invalid/chart.png',
            ),
          ],
        },
      ],
    };

    render(
      <ResultDetailsPanel
        session={unavailableSession}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: '数据质量' }));
    expect(screen.queryByText('数据质量图表')).not.toBeInTheDocument();
  });

  it.each(['needs_input', 'failed', 'cancelled'] as const)(
    'does not restore the removed result status block for %s turns',
    (status) => {
      const statusSession: SessionDetail = {
        ...session,
        turns: [{ ...session.turns[0]!, status: status as TurnStatus }],
      };

      render(
        <ResultDetailsPanel
          session={statusSession}
          turnId="turn-integrated"
          artifactId="quality-artifact"
          onClose={vi.fn()}
        />,
      );

      expect(screen.queryByRole('status', { name: '结果状态' })).not.toBeInTheDocument();
    },
  );

  it('consumes Escape and restores focus to the result trigger when it unmounts', async () => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.textContent = '打开结果详情';
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <ResultDetailsPanel
        session={session}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('keeps Tab and Shift+Tab inside the result dialog', async () => {
    const view = render(
      <ResultDetailsPanel
        session={session}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(dialog).toHaveFocus());
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0]!;
    const last = focusable.at(-1)!;

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    view.unmount();
  });

  it('closes from the backdrop without requiring a panel click', () => {
    const onClose = vi.fn();
    render(
      <ResultDetailsPanel
        session={session}
        turnId="turn-integrated"
        artifactId="quality-artifact"
        onClose={onClose}
      />,
    );

    fireEvent.mouseDown(screen.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
