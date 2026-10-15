import { AlertTriangle, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import type { Artifact, ArtifactFile, VisualizationDescriptor } from '../domain';
import { controlledContentUrl } from '../ui/artifacts';
import { artifactVisualizationDescriptors } from '../ui/visualizations';

interface VisualizationItem {
  artifact: Artifact;
  descriptor: VisualizationDescriptor;
  file?: ArtifactFile;
  contentUrl: string | null;
}

function matchesFile(file: ArtifactFile, fileName: string): boolean {
  return file.name === fileName || file.name === fileName.split('/').at(-1);
}

export function ArtifactVisualizationGallery({
  artifacts,
  businessCategory,
  title,
  emptyMessage,
}: {
  artifacts: Artifact[];
  businessCategory: string;
  title: string;
  emptyMessage: string;
}) {
  const visualizations: VisualizationItem[] = artifacts.flatMap((artifact) =>
    artifactVisualizationDescriptors(artifact)
      .filter((descriptor) => descriptor.businessCategory === businessCategory)
      .map((descriptor) => {
        const file = artifact.files.find((candidate) => matchesFile(candidate, descriptor.fileName));
        return {
          artifact,
          descriptor,
          ...(file ? { file } : {}),
          contentUrl: file ? controlledContentUrl(file.contentUrl) : null,
        };
      }),
  );
  const [failedFiles, setFailedFiles] = useState<Set<string>>(() => new Set());

  return (
    <section
      className="visualization-gallery visualization-section"
      aria-labelledby={`visualization-${businessCategory}-title`}
      data-visualization-category={businessCategory}
    >
      <header>
        <div>
          <h3 id={`visualization-${businessCategory}-title`}>{title}</h3>
          <p>图表来自已校验 Artifact 的公开展示元数据与受控内容地址。</p>
        </div>
        <ImageIcon size={18} aria-hidden="true" />
      </header>
      {visualizations.length === 0 ? (
        <div className="result-unavailable" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <div>
            <strong>{emptyMessage}</strong>
            <p>当前结果没有可读取的真实图表，不生成占位图。</p>
          </div>
        </div>
      ) : (
        <div className="visualization-grid">
          {visualizations.map(({ artifact, descriptor, contentUrl }) => {
            const failureKey = `${artifact.id}:${descriptor.chartId}`;
            const failed = failedFiles.has(failureKey);
            const descriptorUnavailable = descriptor.status === 'not_applicable';
            const descriptorFailed = descriptor.status === 'failed';
            const available =
              !descriptorUnavailable &&
              !descriptorFailed &&
              artifact.status !== 'integrity_failed' &&
              Boolean(contentUrl) &&
              !failed;
            const unavailableText =
              artifact.status === 'integrity_failed'
                ? 'Artifact 完整性校验失败，当前不显示图表。'
                : descriptorUnavailable
                  ? '当前任务条件不适用，服务端未生成此图表。'
                  : descriptorFailed
                    ? '服务端报告此图表生成失败；当前不生成替代图。'
                    : failed
                      ? '图表内容读取失败；请下载已发布文件或重新运行。'
                      : '图表内容暂不可用；Artifact 未提供受控内容地址。';
            const statusLabel = descriptorUnavailable
              ? '当前不适用'
              : descriptorFailed || failed
                ? '图表不可用'
                : artifact.status === 'partial'
                  ? '部分结果'
                  : '已校验';
            return (
              <figure
                className="visualization-card artifact-figure"
                key={`${artifact.id}-${descriptor.chartId}`}
                data-chart-id={descriptor.chartId}
                data-business-category={descriptor.businessCategory}
              >
                {available && contentUrl ? (
                  <img
                    src={contentUrl}
                    alt={`${descriptor.title}，已校验的建筑能源图表`}
                    loading="lazy"
                    onError={() =>
                      setFailedFiles((current) => new Set(current).add(failureKey))
                    }
                  />
                ) : (
                  <div className="visualization-missing" role="status">
                    <AlertTriangle size={17} aria-hidden="true" />
                    <span>{unavailableText}</span>
                  </div>
                )}
                <figcaption>
                  <span>
                    <strong>{descriptor.title}</strong>
                    <small>{descriptor.description ?? '真实计算结果图表'}</small>
                  </span>
                  <em>{statusLabel}</em>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
