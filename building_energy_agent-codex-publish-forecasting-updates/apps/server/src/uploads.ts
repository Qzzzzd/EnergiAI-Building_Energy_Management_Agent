import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
} from '@building-energy/contracts';

import { hashJson, Repository, type UploadRow } from './database.js';
import { WorkspaceManager } from './workspace.js';

export interface IncomingUpload {
  filename: string;
  mimetype: string;
  file: AsyncIterable<Buffer | Uint8Array | string>;
}

export class UploadError extends Error {
  constructor(
    readonly code: 'UPLOAD_LIMIT_EXCEEDED' | 'UNSUPPORTED_MEDIA_TYPE',
    message: string,
  ) {
    super(message);
  }
}

interface StagedUpload {
  originalName: string;
  stagingName: string;
  mediaType: UploadRow['mediaType'];
  size: number;
  sha256: string;
}

const MEDIA_BY_EXTENSION: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.csv': 'text/csv',
};

export class UploadService {
  constructor(
    private readonly repository: Repository,
    private readonly workspaces: WorkspaceManager,
    private readonly clock = () => new Date(),
  ) {}

  async ingest(
    sessionId: string,
    uploads: AsyncIterable<IncomingUpload>,
    idempotencyKey?: string,
  ): Promise<UploadRow[]> {
    this.repository.assertSessionWritable(sessionId);
    const paths = await this.workspaces.createSession(sessionId);
    const batchId = randomUUID();
    const stagingDir = path.join(paths.inputs, `.staging-${batchId}`);
    const finalDir = path.join(paths.inputs, batchId);
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
    const staged: StagedUpload[] = [];
    let totalBytes = 0;
    let committed = false;
    try {
      for await (const upload of uploads) {
        if (staged.length >= MAX_UPLOAD_FILES) {
          throw new UploadError(
            'UPLOAD_LIMIT_EXCEEDED',
            `每批最多上传 ${MAX_UPLOAD_FILES} 个文件。`,
          );
        }
        const originalName = safeOriginalName(upload.filename);
        const extension = path.extname(originalName).toLowerCase();
        const expectedMedia = MEDIA_BY_EXTENSION[extension];
        if (!expectedMedia || normalizeMediaType(upload.mimetype) !== expectedMedia.toLowerCase()) {
          throw new UploadError('UNSUPPORTED_MEDIA_TYPE', '文件扩展名与允许的媒体类型不一致。');
        }
        const stagingName = `${String(staged.length + 1).padStart(2, '0')}-${randomUUID()}${extension}`;
        const target = path.join(stagingDir, stagingName);
        const file = await open(target, 'wx', 0o600);
        const hash = createHash('sha256');
        const prefix: number[] = [];
        const decoder = extension === '.csv' ? new TextDecoder('utf-8', { fatal: true }) : null;
        let size = 0;
        try {
          for await (const chunkValue of upload.file) {
            const chunk =
              typeof chunkValue === 'string' ? Buffer.from(chunkValue) : Buffer.from(chunkValue);
            size += chunk.length;
            totalBytes += chunk.length;
            if (size > MAX_UPLOAD_FILE_BYTES || totalBytes > MAX_UPLOAD_BATCH_BYTES) {
              throw new UploadError('UPLOAD_LIMIT_EXCEEDED', '上传文件或批次超过 200 MB 限制。');
            }
            for (const byte of chunk.subarray(0, Math.max(0, 8 - prefix.length))) prefix.push(byte);
            if (decoder) decoder.decode(chunk, { stream: true });
            hash.update(chunk);
            await file.write(chunk);
          }
          if (decoder) decoder.decode();
        } catch (error) {
          if (error instanceof TypeError && decoder) {
            throw new UploadError(
              'UNSUPPORTED_MEDIA_TYPE',
              'CSV 必须使用 UTF-8 或 UTF-8 BOM 编码。',
            );
          }
          throw error;
        } finally {
          await file.close();
        }
        validateMagic(extension, Buffer.from(prefix));
        staged.push({
          originalName,
          stagingName,
          mediaType: expectedMedia,
          size,
          sha256: hash.digest('hex'),
        });
      }
      if (staged.length === 0)
        throw new UploadError('UNSUPPORTED_MEDIA_TYPE', '上传批次没有文件。');
      const requestHash = hashJson(
        staged.map(({ originalName, mediaType, size, sha256 }) => ({
          original_name: originalName,
          media_type: mediaType,
          size_bytes: size,
          sha256,
        })),
      );
      if (idempotencyKey) {
        const replay = this.repository.getIdempotency<UploadRow[]>(
          `upload:${sessionId}`,
          idempotencyKey,
          requestHash,
        );
        if (replay) return replay;
      }
      await rename(stagingDir, finalDir);
      const now = this.clock().toISOString();
      const rows = staged.map<UploadRow>((file) => ({
        id: randomUUID(),
        sessionId,
        sourceRef: `src:${randomUUID()}`,
        originalName: file.originalName,
        relativePath: `${batchId}/${file.stagingName}`,
        size: file.size,
        sha256: file.sha256,
        mediaType: file.mediaType,
        createdAt: now,
      }));
      for (const row of rows) {
        await this.workspaces.makeImmutable(
          this.workspaces.resolveInput(sessionId, row.relativePath),
        );
      }
      const registered = this.repository.registerUploads(
        rows,
        idempotencyKey
          ? { scope: `upload:${sessionId}`, key: idempotencyKey, requestHash }
          : undefined,
      );
      committed = !registered.replayed;
      return registered.rows;
    } finally {
      if (!committed) {
        await rm(stagingDir, { recursive: true, force: true });
        await rm(finalDir, { recursive: true, force: true });
      }
    }
  }
}

function safeOriginalName(input: string): string {
  const normalized = input.replaceAll('\\', '/');
  const name = path.posix.basename(normalized).normalize('NFC');
  if (name.length === 0 || name === '.' || name === '..' || Buffer.byteLength(name) > 255) {
    throw new UploadError('UNSUPPORTED_MEDIA_TYPE', '文件名无效。');
  }
  return name;
}

function normalizeMediaType(value: string): string {
  const type = value.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'application/csv') return 'text/csv';
  return type ?? '';
}

function validateMagic(extension: string, prefix: Buffer): void {
  if (extension === '.csv') {
    if (prefix.includes(0)) {
      throw new UploadError('UNSUPPORTED_MEDIA_TYPE', 'CSV 内容包含二进制空字节。');
    }
    return;
  }
  const isZip =
    prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    prefix.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (!isZip) throw new UploadError('UNSUPPORTED_MEDIA_TYPE', '工作簿 magic bytes 不合法。');
}
