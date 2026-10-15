import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  ArtifactRefSchema,
  ArtifactParamsSchema,
  ArtifactsQuerySchema,
  CancelTurnRequestSchema,
  CreateSessionRequestSchema,
  DeleteSessionRequestSchema,
  EventsQuerySchema,
  ListSessionsQuerySchema,
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  PUBLIC_API_VERSION,
  QuestionDraftParamsSchema,
  SessionParamsSchema,
  SkillProgressSchema,
  SubmitMessageRequestSchema,
  TurnParamsSchema,
  UpdateSessionRequestSchema,
  UpdateQuestionDraftRequestSchema,
  type ProblemDetails,
  type SseEvent,
  validationProblem,
} from '@building-energy/contracts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { ArtifactError, ArtifactService } from './artifacts.js';
import { RealCodexAdapter } from './codex-adapter.js';
import { loadModelCatalog, ModelSelectionError } from './config.js';
import { problem, Repository, RepositoryError, type SkillJobRow } from './database.js';
import { doctorChecks, overallStatus } from './diagnostics.js';
import { PublicReadGatewayManager } from './public-read-gateway.js';
import { createRotatingJsonlLogger, redactText } from './redaction.js';
import { EventBus, CancellationError, SessionRuntime } from './runtime.js';
import type { CodexAdapter, ServerConfig } from './types.js';
import { UploadError, UploadService, type IncomingUpload } from './uploads.js';
import { WorkspaceManager } from './workspace.js';

export interface ApplicationDependencies {
  config: ServerConfig;
  adapter?: CodexAdapter;
  repository?: Repository;
  workspaces?: WorkspaceManager;
}

export interface Application {
  app: FastifyInstance;
  repository: Repository;
  runtime: SessionRuntime;
  gateways: PublicReadGatewayManager;
}

function skillJobResource(job: SkillJobRow) {
  const metadata = job.metadata;
  const progress = SkillProgressSchema.safeParse(metadata.progress);
  const warnings = Array.isArray(metadata.warnings)
    ? metadata.warnings.flatMap((warning) =>
        typeof warning === 'string' && warning.trim() ? [redactText(warning, 2_000, 10)] : [],
      )
    : undefined;
  const resultRefs = Array.isArray(metadata.result_refs)
    ? metadata.result_refs.flatMap((ref) => {
        const parsed = ArtifactRefSchema.safeParse(ref);
        return parsed.success ? [parsed.data] : [];
      })
    : undefined;
  return {
    turn_id: job.turnId,
    skill_name: job.skillName,
    job_id: job.externalJobId,
    status: job.status,
    ...(typeof metadata.stage === 'string' && metadata.stage.trim()
      ? { stage: redactText(metadata.stage, 256, 2) }
      : {}),
    ...(progress.success ? { progress: progress.data } : {}),
    ...(warnings ? { warnings } : {}),
    ...(resultRefs ? { result_refs: resultRefs } : {}),
  };
}

export async function createApplication(
  dependencies: ApplicationDependencies,
): Promise<Application> {
  const { config } = dependencies;
  const repository = dependencies.repository ?? new Repository(config.databasePath);
  const workspaces = dependencies.workspaces ?? new WorkspaceManager(config.runtimeRoot);
  const models = await loadModelCatalog(config.modelsPath);
  const artifacts = new ArtifactService(repository, workspaces);
  const adapter =
    dependencies.adapter ??
    new RealCodexAdapter({
      projectRoot: config.projectRoot,
      ...(config.codexPath ? { codexPath: config.codexPath } : {}),
      ...(models.codex ? { baseUrl: models.codex.baseUrl, apiKey: models.codex.apiKey } : {}),
    });
  const eventBus = new EventBus();
  const runtime = new SessionRuntime(
    repository,
    workspaces,
    artifacts,
    adapter,
    models,
    config,
    eventBus,
  );
  await runtime.initialize();
  const logger = createRotatingJsonlLogger(path.join(config.runtimeRoot, 'logs'), config.logs);
  const gateways = new PublicReadGatewayManager(
    workspaces,
    config.publicRead,
    logger,
    (sessionId, summary, detail) => runtime.appendPublicReadActivity(sessionId, summary, detail),
  );
  for (const session of repository.listSessions(undefined, 10_000))
    await gateways.start(session.id);
  const uploads = new UploadService(repository, workspaces);
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: MAX_UPLOAD_BATCH_BYTES + 1024 * 1024,
  });
  const eventStreams = new Set<FastifyReply['raw']>();
  await app.register(multipart, {
    limits: {
      files: MAX_UPLOAD_FILES,
      fileSize: MAX_UPLOAD_FILE_BYTES,
      parts: MAX_UPLOAD_FILES + 8,
    },
  });
  const webDist = path.join(config.projectRoot, 'apps/web/dist');
  const webIndexAvailable = await access(path.join(webDist, 'index.html')).then(
    () => true,
    () => false,
  );
  if (webIndexAvailable) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
      decorateReply: true,
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        correlation_id: request.id,
        method: request.method,
        route: request.url.split('?', 1)[0],
        status: reply.statusCode,
      },
      'request completed',
    );
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (
      webIndexAvailable &&
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      request.headers.accept?.includes('text/html')
    ) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return sendProblem(
      reply,
      problem(
        'RESOURCE_NOT_FOUND',
        404,
        '资源不存在',
        '请求的资源不存在。',
        request.id,
        request.url.split('?', 1)[0],
      ),
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    const detail = mapHttpError(error, request);
    logger.warn(
      { correlation_id: request.id, code: detail.code, status: detail.status },
      'request failed',
    );
    return sendProblem(reply, detail);
  });

  app.get('/api/v1/health', async () => {
    const pragmas = repository.pragmas();
    const checks = [
      {
        name: 'node-service',
        status: 'ready' as const,
        version: process.version,
        capability_summary: 'Fastify REST/SSE service',
      },
      {
        name: 'sqlite',
        status:
          pragmas.journalMode.toLowerCase() === 'wal' && pragmas.foreignKeys
            ? ('ready' as const)
            : ('unavailable' as const),
        capability_summary: `WAL=${pragmas.journalMode.toLowerCase() === 'wal'}; foreign_keys=${pragmas.foreignKeys}`,
      },
    ];
    return {
      api_version: PUBLIC_API_VERSION,
      status: checks.every((check) => check.status === 'ready') ? 'ready' : 'unavailable',
      service_version: config.serviceVersion,
      checks,
    };
  });

  app.get('/api/v1/doctor', async () => {
    const checks = await doctorChecks({
      config,
      repository,
      workspaces,
      adapter,
      models: models.models,
    });
    return {
      api_version: PUBLIC_API_VERSION,
      status: overallStatus(checks),
      generated_at: new Date().toISOString(),
      checks,
    };
  });

  app.get('/api/v1/models', async () => ({
    api_version: PUBLIC_API_VERSION,
    models: models.models.map((model) => ({
      id: model.id,
      display_name: model.displayName,
      reasoning_levels: model.reasoningLevels,
      default_reasoning_level: model.defaultReasoningLevel,
      availability: model.availability,
      ...(model.unavailableReason ? { unavailable_reason: model.unavailableReason } : {}),
    })),
    default_model: models.defaultModel,
  }));

  app.get('/api/v1/sessions', async (request, reply) => {
    const query = parseOrReply(ListSessionsQuerySchema, request.query, request, reply);
    if (!query) return;
    const sessions = repository.listSessions(
      query.search,
      query.limit ?? 50,
      query.cursor,
      query.archived === 'true',
    );
    return {
      api_version: PUBLIC_API_VERSION,
      sessions: sessions.map((session) => repository.sessionResource(session)),
      ...(sessions.length === (query.limit ?? 50) ? { next_cursor: sessions.at(-1)!.id } : {}),
    };
  });

  app.post('/api/v1/sessions', async (request, reply) => {
    const body = parseOrReply(CreateSessionRequestSchema, request.body, request, reply);
    if (!body) return;
    const idempotencyKey = optionalIdempotencyKey(request);
    const created = await runtime.createSession({
      model: body.model,
      reasoning: body.reasoning_level,
      ...(body.title ? { title: body.title } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    const sessionId = String((created.response.session as { session_id: string }).session_id);
    try {
      await gateways.start(sessionId);
    } catch (error) {
      if (!created.replayed) {
        await gateways.stop(sessionId).catch(() => undefined);
        await runtime.rollbackSessionCreate(sessionId, idempotencyKey);
      }
      throw error;
    }
    reply.code(201);
    return created.response;
  });

  app.get('/api/v1/sessions/:sessionId', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    if (!params) return;
    const session = repository.requireSession(params.sessionId);
    const lastEventId = repository.lastEventId(params.sessionId);
    return {
      api_version: PUBLIC_API_VERSION,
      session: repository.sessionResource(session),
      messages: repository.messages(params.sessionId),
      turns: repository.turns(params.sessionId).map((turn) => repository.turnResource(turn)),
      sources: repository.uploads(params.sessionId).map((source) => ({
        source_ref: source.sourceRef,
        original_name: source.originalName,
        media_type: source.mediaType,
        size_bytes: source.size,
        sha256: source.sha256,
        created_at: source.createdAt,
      })),
      artifacts: artifacts.resources(params.sessionId),
      skill_jobs: repository.skillJobsForSession(params.sessionId).map(skillJobResource),
      ...(repository.pendingQuestionSet(params.sessionId)
        ? { pending_question_set: repository.pendingQuestionSet(params.sessionId) }
        : {}),
      ...(lastEventId ? { last_event_id: lastEventId } : {}),
    };
  });

  app.patch('/api/v1/sessions/:sessionId', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const body = parseOrReply(UpdateSessionRequestSchema, request.body, request, reply);
    if (!params || !body) return;
    const session = runtime.updateSession(params.sessionId, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.archived !== undefined ? { archived: body.archived } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.reasoning_level !== undefined ? { reasoning: body.reasoning_level } : {}),
    });
    return {
      api_version: PUBLIC_API_VERSION,
      session: repository.sessionResource(session),
    };
  });

  app.put(
    '/api/v1/sessions/:sessionId/question-sets/:questionSetId/draft',
    async (request, reply) => {
      const params = parseOrReply(QuestionDraftParamsSchema, request.params, request, reply);
      const body = parseOrReply(UpdateQuestionDraftRequestSchema, request.body, request, reply);
      if (!params || !body) return;
      repository.requireSession(params.sessionId);
      return {
        api_version: PUBLIC_API_VERSION,
        question_set: repository.updateQuestionDraft(
          params.sessionId,
          params.questionSetId,
          body.draft_answers,
        ),
      };
    },
  );

  app.delete('/api/v1/sessions/:sessionId', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const body = parseOrReply(DeleteSessionRequestSchema, request.body, request, reply);
    if (!params || !body) return;
    const key = requireIdempotencyKey(request);
    if (params.sessionId !== body.confirm_session_id) {
      throw new RepositoryError('SESSION_STATE_INVALID', '删除确认与会话 ID 不一致。');
    }
    await gateways.stop(params.sessionId);
    try {
      const response = await runtime.deleteSession(params.sessionId, body.confirm_session_id, key);
      reply.header('x-codex-host-thread-retention', 'not-controlled-by-application');
      return response;
    } catch (error) {
      try {
        repository.requireSession(params.sessionId);
        await gateways.start(params.sessionId);
      } catch {
        // The durable mapping was already removed; do not recreate an orphan workspace.
      }
      throw error;
    }
  });

  app.post('/api/v1/sessions/:sessionId/messages', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const body = parseOrReply(SubmitMessageRequestSchema, request.body, request, reply);
    if (!params || !body) return;
    const key = requireIdempotencyKey(request);
    const submitted =
      body.kind === 'message'
        ? runtime.submit({
            sessionId: params.sessionId,
            idempotencyKey: key,
            content: body.content,
            sourceRefs: body.source_refs,
          })
        : runtime.submit({
            sessionId: params.sessionId,
            idempotencyKey: key,
            questionSetId: body.question_set_id,
            answers: body.answers,
          });
    reply.code(submitted.replayed ? 200 : 202);
    return {
      api_version: PUBLIC_API_VERSION,
      turn: repository.turnResource(submitted.turn),
      replayed: submitted.replayed,
    };
  });

  app.post('/api/v1/sessions/:sessionId/cancel', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const body = parseOrReply(CancelTurnRequestSchema, request.body, request, reply);
    if (!params || !body) return;
    return runtime.cancel(params.sessionId, requireIdempotencyKey(request), body.reason);
  });

  app.post('/api/v1/sessions/:sessionId/uploads', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    if (!params) return;
    if (!request.isMultipart()) {
      throw new UploadError('UNSUPPORTED_MEDIA_TYPE', '上传端点只接受 multipart/form-data。');
    }
    let version: string | undefined;
    const parts = request.parts();
    async function* incomingFiles(): AsyncGenerator<IncomingUpload> {
      for await (const part of parts) {
        if (part.type === 'field') {
          if (part.fieldname === 'api_version') version = String(part.value);
          continue;
        }
        yield { filename: part.filename, mimetype: part.mimetype, file: part.file };
      }
      if (version !== PUBLIC_API_VERSION) {
        throw new UploadError('UNSUPPORTED_MEDIA_TYPE', 'multipart api_version 缺失或不受支持。');
      }
    }
    const rows = await uploads.ingest(
      params.sessionId,
      incomingFiles(),
      requireIdempotencyKey(request),
    );
    reply.code(201);
    return {
      api_version: PUBLIC_API_VERSION,
      sources: rows.map((row) => ({
        source_ref: row.sourceRef,
        original_name: row.originalName,
        media_type: row.mediaType,
        size_bytes: row.size,
        sha256: row.sha256,
        created_at: row.createdAt,
      })),
    };
  });

  app.get('/api/v1/sessions/:sessionId/events', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const query = parseOrReply(EventsQuerySchema, request.query, request, reply);
    if (!params || !query) return;
    repository.requireSession(params.sessionId);
    const headerCursor = request.headers['last-event-id'];
    if (
      headerCursor !== undefined &&
      (typeof headerCursor !== 'string' || !/^[1-9]\d*$/.test(headerCursor))
    ) {
      throw new HttpProblem(
        problem(
          'VALIDATION_ERROR',
          400,
          '事件游标无效',
          'Last-Event-ID 必须是正十进制整数。',
          request.id,
          request.url.split('?', 1)[0],
        ),
      );
    }
    const cursor =
      query.after_event_id ?? (typeof headerCursor === 'string' ? headerCursor : undefined);
    return streamEvents(
      request,
      reply,
      repository,
      eventBus,
      params.sessionId,
      cursor ? Number(cursor) : 0,
      config.heartbeatMs,
      config.slowConsumerTimeoutMs,
      eventStreams,
    );
  });

  app.get('/api/v1/sessions/:sessionId/artifacts', async (request, reply) => {
    const params = parseOrReply(SessionParamsSchema, request.params, request, reply);
    const query = parseOrReply(ArtifactsQuerySchema, request.query, request, reply);
    if (!params || !query) return;
    repository.requireSession(params.sessionId);
    return {
      api_version: PUBLIC_API_VERSION,
      artifacts: artifacts.resources(params.sessionId, query.turn_id),
    };
  });

  app.get('/api/v1/sessions/:sessionId/turns/:turnId', async (request, reply) => {
    const params = parseOrReply(TurnParamsSchema, request.params, request, reply);
    if (!params) return;
    return {
      api_version: PUBLIC_API_VERSION,
      turn: repository.turnResource(repository.requireSessionTurn(params.sessionId, params.turnId)),
    };
  });

  app.get('/api/v1/artifacts/:artifactId/content', async (request, reply) => {
    const params = parseOrReply(ArtifactParamsSchema, request.params, request, reply);
    if (!params) return;
    const query = request.query as { file?: string };
    const fileIndex = query.file === undefined ? 0 : Number(query.file);
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      throw new ArtifactError('ARTIFACT_REFERENCE_INVALID', 'Artifact 文件索引无效。');
    }
    const file = await artifacts.download(params.artifactId, fileIndex);
    reply.header('content-type', file.mediaType);
    reply.header('content-length', file.size);
    reply.header('etag', `"sha256-${file.sha256}"`);
    reply.header('x-content-sha256', file.sha256);
    const mediaType = file.mediaType.split(';', 1)[0]?.trim().toLowerCase();
    reply.header(
      'content-disposition',
      contentDisposition(file.filename, mediaType === 'text/html' ? 'inline' : 'attachment'),
    );
    return reply.send(file.stream);
  });

  app.addHook('preClose', async () => {
    for (const response of eventStreams) response.destroy();
    eventStreams.clear();
  });

  app.addHook('onClose', async () => {
    await runtime.shutdown();
    await gateways.closeAll();
    repository.close();
  });

  return { app, repository, runtime, gateways };
}

function parseOrReply<T>(
  schema: {
    safeParse(
      input: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: Parameters<typeof validationProblem>[0] };
  },
  input: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): T | undefined {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  sendProblem(reply, validationProblem(parsed.error, request.id, request.url.split('?', 1)[0]));
  return undefined;
}

function sendProblem(reply: FastifyReply, detail: ProblemDetails) {
  return reply.code(detail.status).type('application/problem+json').send(detail);
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new HttpProblem(
      problem(
        'VALIDATION_ERROR',
        400,
        '缺少幂等键',
        '该操作要求有效的 Idempotency-Key 请求头。',
        request.id,
        request.url.split('?', 1)[0],
      ),
    );
  }
  return value;
}

function optionalIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  return requireIdempotencyKey(request);
}

class HttpProblem extends Error {
  constructor(readonly detail: ProblemDetails) {
    super(detail.detail);
  }
}

function mapHttpError(error: unknown, request: FastifyRequest): ProblemDetails {
  if (error instanceof HttpProblem) return error.detail;
  const instance = request.url.split('?', 1)[0];
  if (error instanceof RepositoryError) {
    const statuses: Record<RepositoryError['code'], number> = {
      RESOURCE_NOT_FOUND: 404,
      RESOURCE_CONFLICT: 409,
      IDEMPOTENCY_CONFLICT: 409,
      SESSION_BUSY: 409,
      SESSION_STATE_INVALID: 409,
      MODEL_LOCKED: 409,
      SOURCE_REFERENCE_INVALID: 400,
    };
    return problem(
      error.code,
      statuses[error.code],
      '请求状态冲突',
      error.message,
      request.id,
      instance,
    );
  }
  if (error instanceof ModelSelectionError) {
    return problem(error.code, 400, '模型选择无效', error.message, request.id, instance);
  }
  if (error instanceof UploadError) {
    return problem(
      error.code,
      error.code === 'UPLOAD_LIMIT_EXCEEDED' ? 413 : 415,
      '上传被拒绝',
      error.message,
      request.id,
      instance,
    );
  }
  if (error instanceof ArtifactError) {
    return problem(error.code, 409, 'Artifact 不可用', error.message, request.id, instance);
  }
  if (error instanceof CancellationError) {
    return problem('CANCEL_FAILED', 409, '取消未确认', error.message, request.id, instance);
  }
  if (
    error instanceof Error &&
    /multipart|file.*large|parts limit|files limit/i.test(error.message)
  ) {
    return problem(
      'UPLOAD_LIMIT_EXCEEDED',
      413,
      '上传超过限制',
      '上传文件数量、单文件大小或批次大小超过限制。',
      request.id,
      instance,
    );
  }
  return problem(
    'INTERNAL_ERROR',
    500,
    '服务器内部错误',
    '请求未能完成。请使用 correlation ID 查询脱敏日志。',
    request.id,
    instance,
  );
}

function streamEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: Repository,
  eventBus: EventBus,
  sessionId: string,
  after: number,
  heartbeatMs: number,
  slowConsumerTimeoutMs: number,
  eventStreams: Set<FastifyReply['raw']>,
): void {
  reply.hijack();
  const response = reply.raw;
  eventStreams.add(response);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
  let lastSent = after;
  let replaying = true;
  const pending: SseEvent[] = [];
  let slowTimer: NodeJS.Timeout | undefined;
  const write = (chunk: string) => {
    if (response.destroyed) return;
    if (!response.write(chunk) && !slowTimer) {
      slowTimer = setTimeout(() => response.destroy(), slowConsumerTimeoutMs);
    }
  };
  response.on('drain', () => {
    if (slowTimer) clearTimeout(slowTimer);
    slowTimer = undefined;
  });
  const send = (event: SseEvent) => {
    const id = Number(event.event_id);
    if (id <= lastSent) return;
    lastSent = id;
    write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const listener = (event: SseEvent) => {
    if (replaying) pending.push(event);
    else send(event);
  };
  eventBus.on(sessionId, listener);
  const replayBatchSize = 1_000;
  let replayCursor = after;
  for (;;) {
    const batch = repository.eventsAfter(sessionId, replayCursor, replayBatchSize);
    for (const event of batch) send(event);
    if (batch.length < replayBatchSize) break;
    replayCursor = Number(batch.at(-1)!.event_id);
  }
  replaying = false;
  pending.sort((a, b) => Number(a.event_id) - Number(b.event_id)).forEach(send);
  const heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), heartbeatMs);
  heartbeat.unref();
  const cleanup = () => {
    clearInterval(heartbeat);
    if (slowTimer) clearTimeout(slowTimer);
    eventBus.off(sessionId, listener);
    eventStreams.delete(response);
  };
  request.raw.once('close', cleanup);
  response.once('close', cleanup);
}

function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = filename.replace(/["\r\n\\/]/g, '_');
  return `${disposition}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
