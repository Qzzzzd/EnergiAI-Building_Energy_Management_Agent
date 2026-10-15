import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { CodexAdapter, ModelDefinition, ServerConfig } from './types.js';
import type { Repository } from './database.js';
import type { WorkspaceManager } from './workspace.js';

export interface DependencyCheck {
  name: string;
  status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
  version?: string;
  capability_summary?: string;
  recovery_command?: string;
}

export async function doctorChecks(input: {
  config: ServerConfig;
  repository: Repository;
  workspaces: WorkspaceManager;
  adapter: CodexAdapter;
  models: ModelDefinition[];
}): Promise<DependencyCheck[]> {
  const checks: DependencyCheck[] = [];
  try {
    const pragmas = input.repository.pragmas();
    checks.push({
      name: 'sqlite',
      status:
        pragmas.journalMode.toLowerCase() === 'wal' && pragmas.foreignKeys
          ? 'ready'
          : 'unavailable',
      capability_summary: `journal=${pragmas.journalMode}; foreign_keys=${pragmas.foreignKeys}`,
    });
  } catch {
    checks.push({ name: 'sqlite', status: 'unavailable', capability_summary: '数据库不可读写' });
  }
  try {
    await access(input.workspaces.sessionsRoot);
    checks.push({
      name: 'session-root',
      status: 'ready',
      capability_summary: '隔离会话根可访问；诊断不披露绝对路径',
    });
  } catch {
    checks.push({
      name: 'session-root',
      status: 'unavailable',
      capability_summary: '会话根不可访问',
    });
  }
  checks.push(...(await input.adapter.diagnose()));
  for (const model of input.models) {
    checks.push({
      name: `model:${model.id}`,
      status: input.config.codexProbeModels ? 'unknown' : 'ready',
      capability_summary: input.config.codexProbeModels
        ? '已请求 canary 探测，但适配器未提供无副作用探测结果'
        : '配置 allowlist 已验证；未执行可选 canary',
    });
  }
  checks.push({
    name: 'network-policy',
    status: 'ready',
    capability_summary:
      'Codex shell network disabled；Web Search 与逐跳校验 PublicReadGateway 可观察只读',
  });
  checks.push(...(await discoverSkillChecks(input.config.projectRoot)));
  return checks;
}

export function overallStatus(checks: DependencyCheck[]): 'ready' | 'degraded' | 'unavailable' {
  if (checks.some((check) => check.status === 'unavailable' && isCore(check.name)))
    return 'unavailable';
  if (checks.some((check) => check.status !== 'ready')) return 'degraded';
  return 'ready';
}

async function discoverSkillChecks(projectRoot: string): Promise<DependencyCheck[]> {
  const skillsRoot = path.join(projectRoot, '.agents/skills');
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [
      {
        name: 'skills',
        status: 'unavailable',
        capability_summary: 'Skill 安装目录不可用',
        recovery_command: 'pnpm install:skills',
      },
    ];
  }
  const checks: DependencyCheck[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const skillRoot = path.join(skillsRoot, entry.name);
    const hasInstructions = await exists(path.join(skillRoot, 'SKILL.md'));
    const hasLifecycle = await exists(path.join(skillRoot, 'scripts/skillctl'));
    const hasEnvironment = await exists(
      path.join(projectRoot, '.runtime', 'skill-envs', entry.name, 'bin/python'),
    );
    checks.push({
      name: `skill:${entry.name}`,
      status: hasInstructions && (!hasLifecycle || hasEnvironment) ? 'ready' : 'unavailable',
      capability_summary: hasLifecycle
        ? '计算型 Skill；通用 lifecycle 入口'
        : 'instruction-only Skill；无需计算环境',
      ...(!hasInstructions || (hasLifecycle && !hasEnvironment)
        ? { recovery_command: 'pnpm install:skills' }
        : {}),
    });
  }
  return checks;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isCore(name: string): boolean {
  return [
    'sqlite',
    'session-root',
    'codex-cli',
    'codex-login',
    'codex-sandbox',
    'network-policy',
  ].includes(name);
}
