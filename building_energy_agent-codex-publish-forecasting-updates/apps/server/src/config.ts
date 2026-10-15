import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ReasoningLevelSchema, type ReasoningLevel } from '@building-energy/contracts';
import YAML from 'yaml';

import type { ModelDefinition, ServerConfig } from './types.js';

function integer(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadServerConfig(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const runtimeRoot = path.resolve(
    environment.BE_RUNTIME_ROOT ?? path.join(projectRoot, '.runtime'),
  );
  const databasePath = path.resolve(
    environment.BE_DATABASE_PATH ?? path.join(runtimeRoot, 'app.db'),
  );
  return {
    host: environment.BE_HOST ?? '127.0.0.1',
    port: integer(environment.BE_PORT, 8787, 'BE_PORT'),
    projectRoot: path.resolve(projectRoot),
    runtimeRoot,
    databasePath,
    modelsPath: path.resolve(
      environment.BE_MODELS_PATH ?? path.join(projectRoot, 'config/models.yaml'),
    ),
    serviceVersion: '0.1.0',
    ...(environment.BE_CODEX_PATH ? { codexPath: environment.BE_CODEX_PATH } : {}),
    codexProbeModels: environment.BE_PROBE_MODELS === 'true',
    cancelTimeoutMs: integer(environment.BE_CANCEL_TIMEOUT_MS, 10_000, 'BE_CANCEL_TIMEOUT_MS'),
    heartbeatMs: integer(environment.BE_SSE_HEARTBEAT_MS, 15_000, 'BE_SSE_HEARTBEAT_MS'),
    slowConsumerTimeoutMs: integer(
      environment.BE_SSE_SLOW_CONSUMER_MS,
      5_000,
      'BE_SSE_SLOW_CONSUMER_MS',
    ),
    watchdogIntervalMs: integer(
      environment.BE_CODEX_WATCHDOG_INTERVAL_MS,
      1_000,
      'BE_CODEX_WATCHDOG_INTERVAL_MS',
    ),
    ...(environment.BE_CODEX_WATCHDOG_WARNING_MS
      ? {
          watchdogWarningMs: integer(
            environment.BE_CODEX_WATCHDOG_WARNING_MS,
            30_000,
            'BE_CODEX_WATCHDOG_WARNING_MS',
          ),
        }
      : {}),
    ...(environment.BE_CODEX_WATCHDOG_TERMINATION_MS
      ? {
          watchdogTerminationMs: integer(
            environment.BE_CODEX_WATCHDOG_TERMINATION_MS,
            60_000,
            'BE_CODEX_WATCHDOG_TERMINATION_MS',
          ),
        }
      : {}),
    ...(environment.BE_CODEX_WATCHDOG_STALL_MS
      ? {
          watchdogStallMs: integer(
            environment.BE_CODEX_WATCHDOG_STALL_MS,
            180_000,
            'BE_CODEX_WATCHDOG_STALL_MS',
          ),
        }
      : {}),
    logs: {
      maxBytes: integer(environment.BE_LOG_MAX_BYTES, 5 * 1024 * 1024, 'BE_LOG_MAX_BYTES'),
      backups: integer(environment.BE_LOG_BACKUPS, 3, 'BE_LOG_BACKUPS'),
    },
    publicRead: {
      timeoutMs: integer(
        environment.BE_PUBLIC_READ_TIMEOUT_MS,
        15_000,
        'BE_PUBLIC_READ_TIMEOUT_MS',
      ),
      maxBytes: integer(
        environment.BE_PUBLIC_READ_MAX_BYTES,
        10 * 1024 * 1024,
        'BE_PUBLIC_READ_MAX_BYTES',
      ),
      maxRedirects: integer(
        environment.BE_PUBLIC_READ_MAX_REDIRECTS,
        3,
        'BE_PUBLIC_READ_MAX_REDIRECTS',
      ),
      allowedMediaTypes: [
        'text/',
        'application/json',
        'application/xml',
        'application/rss+xml',
        'application/atom+xml',
        'application/pdf',
        'application/geo+json',
      ],
    },
  };
}

interface RawModelsConfig {
  version?: unknown;
  codex?: {
    base_url?: unknown;
    api_key?: unknown;
    api_key_file?: unknown;
  };
  default?: { model?: unknown; reasoning?: unknown };
  models?: Array<{
    id?: unknown;
    display_name?: unknown;
    reasoning_levels?: unknown;
    default_reasoning_level?: unknown;
  }>;
}

export interface CodexConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ModelCatalog {
  models: ModelDefinition[];
  defaultModel: string;
  codex?: CodexConfig;
}

async function loadCodexConfig(raw: RawModelsConfig['codex']): Promise<CodexConfig | undefined> {
  if (raw === undefined) return undefined;
  if (typeof raw.base_url !== 'string' || raw.base_url.trim().length === 0) {
    throw new Error('models config codex.base_url is invalid');
  }
  const inlineApiKey = raw.api_key;
  const apiKeyFile = raw.api_key_file;
  if (inlineApiKey !== undefined && typeof inlineApiKey !== 'string') {
    throw new Error('models config codex.api_key is invalid');
  }
  if (apiKeyFile !== undefined && typeof apiKeyFile !== 'string') {
    throw new Error('models config codex.api_key_file is invalid');
  }
  if (typeof inlineApiKey === 'string' && typeof apiKeyFile === 'string') {
    throw new Error('models config codex must use api_key or api_key_file, not both');
  }
  const apiKey =
    typeof inlineApiKey === 'string'
      ? inlineApiKey.trim()
      : typeof apiKeyFile === 'string' && apiKeyFile.trim().length > 0
        ? (await readFile(path.resolve(apiKeyFile), 'utf8')).trim()
        : '';
  if (!apiKey) {
    throw new Error('models config codex must provide a non-empty api_key or api_key_file');
  }
  return { baseUrl: raw.base_url.trim(), apiKey };
}

export async function loadModelCatalog(filePath: string): Promise<ModelCatalog> {
  const parsed = YAML.parse(await readFile(filePath, 'utf8')) as RawModelsConfig;
  if (parsed.version !== 1 || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error('models config must have version 1 and at least one model');
  }
  const defaultModel = parsed.default?.model;
  const defaultReasoning = ReasoningLevelSchema.safeParse(parsed.default?.reasoning);
  if (typeof defaultModel !== 'string' || !defaultReasoning.success) {
    throw new Error('models config default model/reasoning is invalid');
  }
  const ids = new Set<string>();
  const models = parsed.models.map((raw): ModelDefinition => {
    if (
      typeof raw.id !== 'string' ||
      raw.id.length === 0 ||
      typeof raw.display_name !== 'string' ||
      raw.display_name.length === 0 ||
      !Array.isArray(raw.reasoning_levels)
    ) {
      throw new Error('models config contains an invalid model entry');
    }
    if (ids.has(raw.id)) throw new Error(`duplicate model id: ${raw.id}`);
    ids.add(raw.id);
    const reasoningLevels = raw.reasoning_levels.map((level) => ReasoningLevelSchema.parse(level));
    if (reasoningLevels.length === 0 || new Set(reasoningLevels).size !== reasoningLevels.length) {
      throw new Error(`model ${raw.id} must have unique reasoning levels`);
    }
    const configuredDefault =
      raw.default_reasoning_level ??
      (raw.id === defaultModel ? defaultReasoning.data : reasoningLevels[0]);
    const modelDefault = ReasoningLevelSchema.parse(configuredDefault) as ReasoningLevel;
    if (!reasoningLevels.includes(modelDefault)) {
      throw new Error(`model ${raw.id} default reasoning is not allowlisted`);
    }
    return {
      id: raw.id,
      displayName: raw.display_name,
      reasoningLevels,
      defaultReasoningLevel: modelDefault,
      availability: 'available',
    };
  });
  const defaultEntry = models.find((model) => model.id === defaultModel);
  if (!defaultEntry || !defaultEntry.reasoningLevels.includes(defaultReasoning.data)) {
    throw new Error('default model/reasoning must reference an allowlisted combination');
  }
  const codex = await loadCodexConfig(parsed.codex);
  return { models, defaultModel, ...(codex ? { codex } : {}) };
}

export function assertAllowedModel(
  catalog: ModelCatalog,
  model: string,
  reasoning: ReasoningLevel,
): ModelDefinition {
  const candidate = catalog.models.find((entry) => entry.id === model);
  if (!candidate || !candidate.reasoningLevels.includes(reasoning)) {
    throw new ModelSelectionError('MODEL_NOT_ALLOWED', '模型或推理级别不在服务器允许列表中。');
  }
  if (candidate.availability !== 'available') {
    throw new ModelSelectionError(
      'MODEL_UNAVAILABLE',
      candidate.unavailableReason ?? '所选模型当前不可用。',
    );
  }
  return candidate;
}

export class ModelSelectionError extends Error {
  constructor(
    readonly code: 'MODEL_NOT_ALLOWED' | 'MODEL_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}
