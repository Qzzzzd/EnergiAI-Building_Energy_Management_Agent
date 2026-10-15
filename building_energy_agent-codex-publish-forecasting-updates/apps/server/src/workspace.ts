import { access, chmod, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionIdSchema } from '@building-energy/contracts';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SessionPaths {
  root: string;
  workspace: string;
  inputs: string;
  artifacts: string;
  socket: string;
}

export class WorkspaceBoundaryError extends Error {}

export class WorkspaceManager {
  readonly sessionsRoot: string;
  readonly socketsRoot: string;

  constructor(readonly runtimeRoot: string) {
    this.sessionsRoot = path.resolve(runtimeRoot, 'sessions');
    this.socketsRoot = socketRootForRuntime(runtimeRoot);
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.socketsRoot, { recursive: true, mode: 0o700 });
  }

  paths(sessionId: string): SessionPaths {
    SessionIdSchema.parse(sessionId);
    const root = this.joinControlled(this.sessionsRoot, sessionId);
    const workspace = this.joinControlled(root, 'workspace');
    return {
      root,
      workspace,
      inputs: this.joinControlled(root, 'inputs'),
      artifacts: this.joinControlled(workspace, 'artifacts'),
      socket: this.joinControlled(this.socketsRoot, `${socketId(sessionId)}.sock`),
    };
  }

  async createSession(sessionId: string): Promise<SessionPaths> {
    const paths = this.paths(sessionId);
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
    await mkdir(paths.inputs, { recursive: true, mode: 0o700 });
    await mkdir(paths.artifacts, { recursive: true, mode: 0o700 });
    return paths;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const paths = this.paths(sessionId);
    await this.assertExistingInside(this.sessionsRoot, paths.root, false);
    await rm(paths.root, { recursive: true, force: true });
  }

  async detachSession(sessionId: string): Promise<string> {
    const paths = this.paths(sessionId);
    await this.assertExistingInside(this.sessionsRoot, paths.root, false);
    const trashRoot = path.join(this.sessionsRoot, '.trash');
    await mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const tombstone = path.join(trashRoot, `${sessionId}--deleted--${randomUUID()}`);
    await rename(paths.root, tombstone);
    return tombstone;
  }

  async restoreDetachedSession(sessionId: string, tombstone: string): Promise<void> {
    await this.assertExistingInside(path.join(this.sessionsRoot, '.trash'), tombstone, false);
    await rename(tombstone, this.paths(sessionId).root);
  }

  async finalizeDetachedSession(tombstone: string): Promise<void> {
    await this.assertExistingInside(path.join(this.sessionsRoot, '.trash'), tombstone, false);
    await rm(tombstone, { recursive: true, force: true });
  }

  async reconcileTrash(sessionIds: string[]): Promise<void> {
    const trashRoot = path.join(this.sessionsRoot, '.trash');
    await mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const entries = (await readdir(trashRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    const retained = new Set<string>();
    for (const sessionId of sessionIds) {
      const root = this.paths(sessionId).root;
      const rootExists = await access(root).then(
        () => true,
        () => false,
      );
      if (rootExists) continue;
      const candidate = entries.find((entry) => entry.name.startsWith(`${sessionId}--deleted--`));
      if (!candidate) throw new WorkspaceBoundaryError('persisted session workspace is missing');
      const tombstone = path.join(trashRoot, candidate.name);
      await rename(tombstone, root);
      retained.add(candidate.name);
    }
    for (const entry of entries) {
      if (!retained.has(entry.name)) {
        await rm(path.join(trashRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  resolveWorkspaceWrite(sessionId: string, relativePath: string): string {
    return this.resolveRelative(this.paths(sessionId).workspace, relativePath);
  }

  resolveInput(sessionId: string, relativePath: string): string {
    return this.resolveRelative(this.paths(sessionId).inputs, relativePath);
  }

  resolveArtifact(sessionId: string, relativePath: string): string {
    return this.resolveRelative(this.paths(sessionId).artifacts, relativePath);
  }

  relativeSourcePath(sessionId: string, inputRelativePath: string): string {
    const paths = this.paths(sessionId);
    const absolute = this.resolveRelative(paths.inputs, inputRelativePath);
    const relative = path.relative(paths.workspace, absolute).split(path.sep).join('/');
    if (!relative.startsWith('../inputs/')) throw new WorkspaceBoundaryError('invalid source path');
    return relative;
  }

  async makeImmutable(filePath: string): Promise<void> {
    await chmod(filePath, 0o400);
  }

  async assertExistingInside(root: string, candidate: string, allowRoot = false): Promise<string> {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!this.isInside(realRoot, realCandidate, allowRoot)) {
      throw new WorkspaceBoundaryError('path escapes controlled root');
    }
    return realCandidate;
  }

  async assertWritableTarget(root: string, candidate: string): Promise<void> {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!this.isInside(resolvedRoot, resolvedCandidate, false)) {
      throw new WorkspaceBoundaryError('target escapes controlled root');
    }
    const parent = path.dirname(resolvedCandidate);
    let current = resolvedRoot;
    const parentSegments = path.relative(resolvedRoot, parent).split(path.sep).filter(Boolean);
    for (const segment of parentSegments) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new WorkspaceBoundaryError('target parent is not a controlled directory');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 });
      }
      await this.assertExistingInside(resolvedRoot, current, true);
    }
    await this.assertExistingInside(resolvedRoot, parent, true);
    try {
      const existing = await lstat(resolvedCandidate);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new WorkspaceBoundaryError('target is not a regular file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private resolveRelative(root: string, relativePath: string): string {
    if (
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath.includes('\\') ||
      relativePath.includes('\0')
    ) {
      throw new WorkspaceBoundaryError('path must be relative');
    }
    const segments = relativePath.split('/');
    if (
      segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')
    ) {
      throw new WorkspaceBoundaryError('path contains an unsafe segment');
    }
    return this.joinControlled(root, ...segments);
  }

  private joinControlled(root: string, ...segments: string[]): string {
    const result = path.resolve(root, ...segments);
    if (!this.isInside(path.resolve(root), result, false)) {
      throw new WorkspaceBoundaryError('path escapes controlled root');
    }
    return result;
  }

  private isInside(root: string, candidate: string, allowRoot: boolean): boolean {
    const relative = path.relative(root, candidate);
    return (
      (allowRoot && relative === '') ||
      (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }
}

function socketId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
}

export function socketRootForRuntime(runtimeRoot: string): string {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const preferredSocketsRoot = path.join(resolvedRuntimeRoot, 's');
  const longestSocket = path.join(preferredSocketsRoot, `${'f'.repeat(20)}.sock`);
  return Buffer.byteLength(longestSocket) < 108
    ? preferredSocketsRoot
    : path.join(tmpdir(), `be-codex-${socketId(resolvedRuntimeRoot)}`);
}

export function sessionSocketPath(runtimeRoot: string, sessionId: string): string {
  return path.join(socketRootForRuntime(runtimeRoot), `${socketId(sessionId)}.sock`);
}
