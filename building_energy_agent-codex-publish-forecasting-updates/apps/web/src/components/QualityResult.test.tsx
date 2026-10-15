import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact } from '../domain';
import { QualityResult } from './QualityResult';

afterEach(cleanup);

const artifact: Artifact = {
  id: 'quality-artifact',
  turnId: 'turn-quality',
  artifactType: 'QualityProfile',
  status: 'succeeded',
  producer: { skillName: 'building-energy-data-quality', jobId: 'quality-job' },
  summary: {
    conclusion: '数据可用于分析，但冷量测点存在连续缺口。',
    overall_score: 72.5,
    dimensions: { DQ1: { score: 68, summary: '存在缺失区间。' } },
    issues: [
      {
        dimension: 'DQ1',
        severity: 'warning',
        summary: '连续缺失',
        evidence: { missing_count: 12, interval: '15min' },
        affected_scope: { point_ids: ['CHW-01'], rows: 12 },
        recommended_action: '补录或标记该区间。',
      },
    ],
    recommendations: ['先处理连续缺失再训练预测模型。'],
  },
  warnings: [],
  files: [],
};

describe('QualityResult', () => {
  it('keeps issue analysis limited to the server-provided issue summary', () => {
    render(<QualityResult artifact={artifact} />);

    expect(screen.getByText('72.5')).toBeVisible();
    expect(screen.getByText('完整性')).toBeVisible();
    expect(screen.getByText('连续缺失')).toBeVisible();
    expect(screen.queryByText(/证据：/)).not.toBeInTheDocument();
    expect(screen.queryByText(/影响范围：/)).not.toBeInTheDocument();
    expect(screen.queryByText('补录或标记该区间。')).not.toBeInTheDocument();
    expect(screen.getByText('先处理连续缺失再训练预测模型。')).toBeVisible();
  });
});
