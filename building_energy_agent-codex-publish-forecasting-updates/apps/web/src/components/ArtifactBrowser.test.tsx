import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Artifact } from '../domain';
import { ArtifactBrowser } from './ArtifactBrowser';

afterEach(cleanup);

const sha256 = 'a'.repeat(64);

function artifact(status: Artifact['status']): Artifact {
  return {
    id: 'artifact-1',
    turnId: 'turn-1',
    artifactType: 'ForecastBundle',
    status,
    producer: { skillName: 'building-energy-load-forecasting', jobId: 'job-1' },
    summary: {},
    warnings: [],
    files: [
      {
        id: 'artifact-1:0',
        name: 'forecast.csv',
        role: 'forecast-data',
        mediaType: 'text/csv',
        sizeBytes: 2_048,
        sha256,
        contentUrl: '/api/v1/artifacts/artifact-1/content?file=0',
      },
    ],
  };
}

describe('ArtifactBrowser', () => {
  it('renders only the server-controlled content URL for a verified artifact', () => {
    render(<ArtifactBrowser artifacts={[artifact('succeeded')]} />);

    const download = screen.getByRole('link', { name: '下载 forecast.csv' });
    expect(download).toHaveAttribute('href', '/api/v1/artifacts/artifact-1/content?file=0');
    expect(download).toHaveAttribute('download', 'forecast.csv');
    expect(screen.getAllByText('建筑能源负荷预测结果').length).toBeGreaterThan(0);
    expect(screen.getByText(/预测数据/)).toBeVisible();
    expect(screen.getByTitle(sha256)).toHaveTextContent('aaaaaaaaaa…aaaaaa');
    expect(screen.queryByText('building-energy-load-forecasting')).not.toBeInTheDocument();
    expect(screen.queryByText('job-1')).not.toBeInTheDocument();
  });

  it('withholds the download action when integrity failed', () => {
    render(<ArtifactBrowser artifacts={[artifact('integrity_failed')]} />);

    expect(screen.getAllByText('完整性失败').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: '下载 forecast.csv' })).not.toBeInTheDocument();
  });
});
