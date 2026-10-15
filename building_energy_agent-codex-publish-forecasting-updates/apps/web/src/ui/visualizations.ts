import type { Artifact, ArtifactFile, VisualizationDescriptor } from '../domain';
import { controlledContentUrl } from './artifacts';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function order(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function descriptor(value: unknown, fallbackOrder: number): VisualizationDescriptor | null {
  const item = record(value);
  if (!item) return null;
  const chartId = text(item.chart_id) ?? text(item.chartId);
  const title = text(item.title);
  const fileName = text(item.file_name) ?? text(item.fileName);
  const businessCategory = text(item.business_category) ?? text(item.businessCategory);
  if (!chartId || !title || !fileName || !businessCategory) return null;
  const status =
    item.status === 'available' || item.status === 'failed' || item.status === 'not_applicable'
      ? item.status
      : undefined;
  const description = text(item.description);
  return {
    chartId,
    title,
    displayOrder: order(item.display_order ?? item.displayOrder, fallbackOrder),
    fileName,
    businessCategory,
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
  };
}

export function artifactVisualizationDescriptors(artifact: Artifact): VisualizationDescriptor[] {
  if (!Array.isArray(artifact.summary.visualizations)) return [];
  return artifact.summary.visualizations
    .map((value, index) => descriptor(value, index))
    .filter((value): value is VisualizationDescriptor => value !== null)
    .sort((left, right) => left.displayOrder - right.displayOrder);
}

export interface ArtifactVisualization {
  artifact: Artifact;
  descriptor: VisualizationDescriptor;
  file: ArtifactFile;
}

function matchesFile(file: ArtifactFile, fileName: string): boolean {
  return file.name === fileName || file.name === fileName.split('/').at(-1);
}

export function artifactVisualizations(
  artifact: Artifact,
  businessCategory?: string,
): ArtifactVisualization[] {
  return artifactVisualizationDescriptors(artifact).flatMap((descriptor) => {
    if (businessCategory && descriptor.businessCategory !== businessCategory) return [];
    if (descriptor.status && descriptor.status !== 'available') return [];
    const file = artifact.files.find((candidate) => matchesFile(candidate, descriptor.fileName));
    if (!file || !controlledContentUrl(file.contentUrl)) return [];
    return [{ artifact, descriptor, file }];
  });
}
