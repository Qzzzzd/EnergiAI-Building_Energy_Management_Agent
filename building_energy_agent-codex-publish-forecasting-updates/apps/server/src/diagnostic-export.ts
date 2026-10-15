import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ModelCatalog } from './config.js';
import type { Repository } from './database.js';
import { doctorChecks, overallStatus } from './diagnostics.js';
import type { CodexAdapter, ServerConfig } from './types.js';
import type { WorkspaceManager } from './workspace.js';

export async function buildDiagnosticExport(input: {
  config: ServerConfig;
  repository: Repository;
  workspaces: WorkspaceManager;
  adapter: CodexAdapter;
  models: ModelCatalog;
}) {
  const checks = await doctorChecks({
    config: input.config,
    repository: input.repository,
    workspaces: input.workspaces,
    adapter: input.adapter,
    models: input.models.models,
  });
  const sessionCounts = input.repository.db
    .prepare('SELECT status, COUNT(*) AS count FROM sessions GROUP BY status ORDER BY status')
    .all()
    .map((row) => ({
      status: String((row as Record<string, unknown>).status),
      count: Number((row as Record<string, unknown>).count),
    }));
  const turnCounts = input.repository.db
    .prepare('SELECT status, COUNT(*) AS count FROM turns GROUP BY status ORDER BY status')
    .all()
    .map((row) => ({
      status: String((row as Record<string, unknown>).status),
      count: Number((row as Record<string, unknown>).count),
    }));
  const logs = await logInventory(path.join(input.config.runtimeRoot, 'logs'));
  return {
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    service_version: input.config.serviceVersion,
    node_version: process.version,
    status: overallStatus(checks),
    checks,
    state_summary: { sessions: sessionCounts, turns: turnCounts },
    log_inventory: logs,
    privacy:
      'This export contains aggregate states, dependency checks and log file metadata only. It excludes IDs, paths, file contents, prompts, credentials and environment variables.',
  };
}

async function logInventory(
  directory: string,
): Promise<Array<{ name: string; size_bytes: number }>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.filter((candidate) => candidate.isFile()).slice(0, 20)) {
      const info = await stat(path.join(directory, entry.name));
      files.push({ name: path.basename(entry.name), size_bytes: info.size });
    }
    return files;
  } catch {
    return [];
  }
}
