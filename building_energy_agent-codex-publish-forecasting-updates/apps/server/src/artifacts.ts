import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  ArtifactManifestSchema,
  ArtifactResourceSchema,
  type ArtifactManifest,
  type ArtifactRef,
  type ArtifactResource,
} from '@building-energy/contracts';

import { Repository } from './database.js';
import { redactText } from './redaction.js';
import { WorkspaceBoundaryError, WorkspaceManager } from './workspace.js';

export class ArtifactError extends Error {
  constructor(
    readonly code: 'ARTIFACT_REFERENCE_INVALID' | 'ARTIFACT_INTEGRITY_FAILED',
    message: string,
  ) {
    super(message);
  }
}

export interface ArtifactDownload {
  absolutePath: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  stream: ReturnType<typeof createReadStream>;
}

export class ArtifactService {
  constructor(
    private readonly repository: Repository,
    private readonly workspaces: WorkspaceManager,
    private readonly clock = () => new Date(),
  ) {}

  async registerManifest(
    sessionId: string,
    turnId: string,
    manifestRelativePath: string,
  ): Promise<{ ref: ArtifactRef; resource: ArtifactResource }> {
    try {
      const manifestPath = this.workspaces.resolveArtifact(sessionId, manifestRelativePath);
      await this.workspaces.assertExistingInside(
        this.workspaces.paths(sessionId).artifacts,
        manifestPath,
      );
      const manifestBytes = await readFile(manifestPath);
      const manifest = ArtifactManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
      this.repository.uploadsByRefs(sessionId, manifest.source_ids);
      await this.verifyManifestFiles(sessionId, manifest);
      const manifestSha = createHash('sha256').update(manifestBytes).digest('hex');
      this.repository.registerArtifact({
        id: manifest.artifact_id,
        sessionId,
        turnId,
        manifestPath: manifestRelativePath,
        type: manifest.artifact_type,
        status: manifest.status,
        sha256: manifestSha,
        manifestJson: JSON.stringify(manifest),
        integrityError: null,
        createdAt: this.clock().toISOString(),
      });
      return { ref: this.ref(manifest, sessionId, turnId), resource: this.resource(manifest) };
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if (error instanceof WorkspaceBoundaryError || error instanceof SyntaxError) {
        throw new ArtifactError('ARTIFACT_REFERENCE_INVALID', 'Artifact manifest 引用无效。');
      }
      throw error;
    }
  }

  resources(sessionId: string, turnId?: string): ArtifactResource[] {
    return this.repository.artifacts(sessionId, turnId).map((row) => {
      if (row.integrityError) {
        throw new ArtifactError('ARTIFACT_INTEGRITY_FAILED', 'Artifact 完整性校验失败。');
      }
      return this.resource(JSON.parse(row.manifestJson) as ArtifactManifest);
    });
  }

  /**
   * Return the small, verified Artifact index that is safe to give back to
   * Codex.  Registration verifies every listed file before persisting the
   * manifest; this method intentionally includes metadata, hashes and links
   * only, never report/file contents or the full manifest document.
   */
  compactIndex(
    sessionId: string,
    turnId?: string,
  ): Array<{
    artifact_id: string;
    artifact_type: string;
    status: ArtifactResource['status'];
    producer: ArtifactResource['producer'];
    source_ids: string[];
    files: Array<{
      name: string;
      media_type: string;
      size_bytes: number;
      sha256: string;
      role: string;
      content_url: string;
    }>;
    summary: Record<string, unknown>;
    warnings: string[];
  }> {
    return this.resources(sessionId, turnId).map((artifact) => ({
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      status: artifact.status,
      producer: artifact.producer,
      source_ids: artifact.source_ids.slice(0, 32),
      files: artifact.files.slice(0, 32).map((file) => ({
        name: file.name,
        media_type: file.media_type,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
        role: file.role,
        content_url: file.content_url,
      })),
      summary: compactRecord(artifact.summary),
      warnings: artifact.warnings.slice(0, 16),
    }));
  }

  resourceById(artifactId: string): ArtifactResource {
    const row = this.repository.artifact(artifactId);
    if (row.integrityError) {
      throw new ArtifactError('ARTIFACT_INTEGRITY_FAILED', 'Artifact 完整性校验失败。');
    }
    return this.resource(JSON.parse(row.manifestJson) as ArtifactManifest);
  }

  async download(artifactId: string, fileIndex: number): Promise<ArtifactDownload> {
    const row = this.repository.artifact(artifactId);
    if (row.integrityError) {
      throw new ArtifactError('ARTIFACT_INTEGRITY_FAILED', 'Artifact 完整性校验失败。');
    }
    const manifest = ArtifactManifestSchema.parse(JSON.parse(row.manifestJson));
    const file = manifest.files[fileIndex];
    if (!file) throw new ArtifactError('ARTIFACT_REFERENCE_INVALID', 'Artifact 文件不存在。');
    try {
      const absolutePath = this.workspaces.resolveArtifact(row.sessionId, file.relative_path);
      await this.workspaces.assertExistingInside(
        this.workspaces.paths(row.sessionId).artifacts,
        absolutePath,
      );
      const actual = await fileDigest(absolutePath);
      if (actual.size !== file.size_bytes || actual.sha256 !== file.sha256) {
        this.repository.markArtifactIntegrityError(row.id, 'size or SHA-256 mismatch');
        throw new ArtifactError('ARTIFACT_INTEGRITY_FAILED', 'Artifact 内容与登记哈希不一致。');
      }
      return {
        absolutePath,
        filename: path.basename(file.relative_path),
        mediaType: file.media_type,
        size: actual.size,
        sha256: actual.sha256,
        stream: createReadStream(absolutePath),
      };
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      this.repository.markArtifactIntegrityError(row.id, 'file missing or outside artifact root');
      throw new ArtifactError('ARTIFACT_REFERENCE_INVALID', 'Artifact 文件引用无效。');
    }
  }

  private async verifyManifestFiles(sessionId: string, manifest: ArtifactManifest): Promise<void> {
    for (const file of manifest.files) {
      const absolute = this.workspaces.resolveArtifact(sessionId, file.relative_path);
      await this.workspaces.assertExistingInside(
        this.workspaces.paths(sessionId).artifacts,
        absolute,
      );
      const actual = await fileDigest(absolute);
      if (actual.size !== file.size_bytes || actual.sha256 !== file.sha256) {
        throw new ArtifactError('ARTIFACT_INTEGRITY_FAILED', 'Artifact 文件大小或哈希不匹配。');
      }
    }
  }

  private ref(manifest: ArtifactManifest, sessionId: string, turnId: string): ArtifactRef {
    return {
      artifact_id: manifest.artifact_id,
      artifact_type: manifest.artifact_type,
      status: manifest.status,
      manifest_url: `/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts?turn_id=${encodeURIComponent(turnId)}`,
    };
  }

  private resource(manifest: ArtifactManifest): ArtifactResource {
    return ArtifactResourceSchema.parse({
      schema_version: manifest.schema_version,
      artifact_id: manifest.artifact_id,
      artifact_type: manifest.artifact_type,
      producer: manifest.producer,
      source_ids: manifest.source_ids,
      status: manifest.status,
      files: manifest.files.map((file, index) => ({
        name: path.posix.basename(file.relative_path),
        media_type: file.media_type,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
        role: file.role,
        content_url: `/api/v1/artifacts/${encodeURIComponent(manifest.artifact_id)}/content?file=${index}`,
      })),
      summary: redactJsonObject(manifest.summary),
      warnings: manifest.warnings.map((warning) => redactText(warning, 2_000, 20)),
    });
  }
}

function redactJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 200)
      .map(([key, item]) => [key, redactJsonValue(item, 0)]),
  );
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).slice(0, 48));
}

function redactJsonValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, 4_000, 40);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 6) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactJsonValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 200)
        .map(([key, item]) => [key, redactJsonValue(item, depth + 1)]),
    );
  }
  return null;
}

async function fileDigest(filePath: string): Promise<{ size: number; sha256: string }> {
  const info = await stat(await realpath(filePath));
  if (!info.isFile())
    throw new ArtifactError('ARTIFACT_REFERENCE_INVALID', 'Artifact 不是普通文件。');
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest('hex') };
}
