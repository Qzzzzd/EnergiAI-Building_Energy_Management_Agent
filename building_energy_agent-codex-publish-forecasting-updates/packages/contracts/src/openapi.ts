import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas31';
import { z } from 'zod';

import { PUBLIC_API_VERSION } from './versions.js';

// Zod OpenAPI decorates schemas at construction time, so schema modules must be
// loaded only after the extension is installed.
extendZodWithOpenApi(z);

const { AgentTurnEnvelopeSchema, QuestionSchema } = await import('./agent-turn.js');
const { ArtifactManifestSchema, ArtifactRefSchema, ArtifactResourceSchema } =
  await import('./artifact.js');
const { SseEventSchema } = await import('./events.js');
const { ExecutionPlanSchema } = await import('./execution-plan.js');
const { ProblemDetailsSchema } = await import('./problem.js');
const {
  ArtifactParamsSchema,
  ArtifactsQuerySchema,
  ArtifactsResponseSchema,
  CancelTurnRequestSchema,
  CancelTurnResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  DeleteSessionRequestSchema,
  DeleteSessionResponseSchema,
  DoctorResponseSchema,
  EventsHeadersSchema,
  EventsQuerySchema,
  HealthResponseSchema,
  IdempotencyHeadersSchema,
  ListSessionsQuerySchema,
  ListSessionsResponseSchema,
  ModelsResponseSchema,
  QuestionDraftParamsSchema,
  SessionDetailResponseSchema,
  SessionParamsSchema,
  SubmitMessageRequestSchema,
  SubmitMessageResponseSchema,
  TurnParamsSchema,
  TurnResponseSchema,
  UpdateSessionRequestSchema,
  UpdateSessionResponseSchema,
  UpdateQuestionDraftRequestSchema,
  UpdateQuestionDraftResponseSchema,
  UploadBatchRequestSchema,
  UploadBatchResponseSchema,
} = await import('./rest.js');
const { PersistedSkillJobStateSchema, SkillEventSchema, SkillLifecycleCommandSchema } =
  await import('./skill.js');

const registry = new OpenAPIRegistry();

const namedSchemas = {
  ProblemDetails: ProblemDetailsSchema,
  Question: QuestionSchema,
  AgentTurnEnvelope: AgentTurnEnvelopeSchema,
  ArtifactRef: ArtifactRefSchema,
  ArtifactManifest: ArtifactManifestSchema,
  ArtifactResource: ArtifactResourceSchema,
  SseEvent: SseEventSchema,
  ExecutionPlan: ExecutionPlanSchema,
  SkillLifecycleCommand: SkillLifecycleCommandSchema,
  SkillEvent: SkillEventSchema,
  PersistedSkillJobState: PersistedSkillJobStateSchema,
  ModelsResponse: ModelsResponseSchema,
  CreateSessionRequest: CreateSessionRequestSchema,
  CreateSessionResponse: CreateSessionResponseSchema,
  ListSessionsResponse: ListSessionsResponseSchema,
  SessionDetailResponse: SessionDetailResponseSchema,
  UpdateSessionRequest: UpdateSessionRequestSchema,
  UpdateSessionResponse: UpdateSessionResponseSchema,
  UpdateQuestionDraftRequest: UpdateQuestionDraftRequestSchema,
  UpdateQuestionDraftResponse: UpdateQuestionDraftResponseSchema,
  DeleteSessionRequest: DeleteSessionRequestSchema,
  DeleteSessionResponse: DeleteSessionResponseSchema,
  SubmitMessageRequest: SubmitMessageRequestSchema,
  SubmitMessageResponse: SubmitMessageResponseSchema,
  CancelTurnRequest: CancelTurnRequestSchema,
  CancelTurnResponse: CancelTurnResponseSchema,
  UploadBatchRequest: UploadBatchRequestSchema,
  UploadBatchResponse: UploadBatchResponseSchema,
  ArtifactsResponse: ArtifactsResponseSchema,
  TurnResponse: TurnResponseSchema,
  HealthResponse: HealthResponseSchema,
  DoctorResponse: DoctorResponseSchema,
} as const;

for (const [name, schema] of Object.entries(namedSchemas)) {
  registry.register(name, schema);
}

const jsonResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema } },
});

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemDetailsSchema } },
});

const problemResponses = {
  400: problemResponse('请求不符合公共契约'),
  404: problemResponse('资源不存在或不属于当前会话'),
  409: problemResponse('资源状态或幂等键冲突'),
  500: problemResponse('服务内部错误'),
};

registry.registerPath({
  method: 'get',
  path: '/api/v1/health',
  operationId: 'getHealth',
  responses: {
    200: jsonResponse('轻量健康状态', HealthResponseSchema),
    500: problemResponses[500],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/doctor',
  operationId: 'getDoctor',
  responses: {
    200: jsonResponse('详细依赖诊断', DoctorResponseSchema),
    500: problemResponses[500],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/models',
  operationId: 'listModels',
  responses: {
    200: jsonResponse('已验证的模型候选', ModelsResponseSchema),
    500: problemResponses[500],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions',
  operationId: 'listSessions',
  request: { query: ListSessionsQuerySchema },
  responses: {
    200: jsonResponse('会话列表', ListSessionsResponseSchema),
    400: problemResponses[400],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions',
  operationId: 'createSession',
  request: {
    headers: IdempotencyHeadersSchema,
    body: { content: { 'application/json': { schema: CreateSessionRequestSchema } } },
  },
  responses: {
    201: jsonResponse('新建会话', CreateSessionResponseSchema),
    400: problemResponses[400],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{sessionId}',
  operationId: 'getSession',
  request: { params: SessionParamsSchema },
  responses: {
    200: jsonResponse('会话、消息、turn 与待回答问题', SessionDetailResponseSchema),
    404: problemResponses[404],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/sessions/{sessionId}',
  operationId: 'updateSession',
  request: {
    params: SessionParamsSchema,
    body: { content: { 'application/json': { schema: UpdateSessionRequestSchema } } },
  },
  responses: {
    200: jsonResponse('已更新会话', UpdateSessionResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/sessions/{sessionId}',
  operationId: 'deleteSession',
  request: {
    params: SessionParamsSchema,
    headers: IdempotencyHeadersSchema,
    body: { content: { 'application/json': { schema: DeleteSessionRequestSchema } } },
  },
  responses: {
    200: jsonResponse('已删除会话', DeleteSessionResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/sessions/{sessionId}/question-sets/{questionSetId}/draft',
  operationId: 'updateQuestionDraft',
  request: {
    params: QuestionDraftParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateQuestionDraftRequestSchema } },
    },
  },
  responses: {
    200: jsonResponse('持久化问题组草稿', UpdateQuestionDraftResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/{sessionId}/uploads',
  operationId: 'uploadSources',
  request: {
    params: SessionParamsSchema,
    headers: IdempotencyHeadersSchema,
    body: { content: { 'multipart/form-data': { schema: UploadBatchRequestSchema } } },
  },
  responses: {
    201: jsonResponse('不可变上传快照', UploadBatchResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/{sessionId}/messages',
  operationId: 'submitMessage',
  request: {
    params: SessionParamsSchema,
    headers: IdempotencyHeadersSchema,
    body: { content: { 'application/json': { schema: SubmitMessageRequestSchema } } },
  },
  responses: {
    202: jsonResponse('已接受或幂等重放的 turn', SubmitMessageResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/sessions/{sessionId}/cancel',
  operationId: 'cancelTurn',
  request: {
    params: SessionParamsSchema,
    headers: IdempotencyHeadersSchema,
    body: { content: { 'application/json': { schema: CancelTurnRequestSchema } } },
  },
  responses: {
    200: jsonResponse('已确认实际执行停止', CancelTurnResponseSchema),
    400: problemResponses[400],
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{sessionId}/events',
  operationId: 'streamSessionEvents',
  request: {
    params: SessionParamsSchema,
    query: EventsQuerySchema,
    headers: EventsHeadersSchema,
  },
  responses: {
    200: {
      description: '按 event_id 有序且可续传的 SSE；data 为 SseEvent',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    400: problemResponses[400],
    404: problemResponses[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{sessionId}/turns/{turnId}',
  operationId: 'getTurnResult',
  request: { params: TurnParamsSchema },
  responses: {
    200: jsonResponse('持久化 turn 状态与结果引用', TurnResponseSchema),
    404: problemResponses[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/sessions/{sessionId}/artifacts',
  operationId: 'listArtifacts',
  request: { params: SessionParamsSchema, query: ArtifactsQuerySchema },
  responses: {
    200: jsonResponse('当前会话的受控 artifact 元数据', ArtifactsResponseSchema),
    404: problemResponses[404],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/artifacts/{artifactId}/content',
  operationId: 'downloadArtifactContent',
  request: { params: ArtifactParamsSchema },
  responses: {
    200: {
      description: '经归属、大小、哈希和媒体类型校验的 artifact 内容',
      content: {
        'application/octet-stream': { schema: z.string().meta({ format: 'binary' }) },
      },
    },
    404: problemResponses[404],
    409: problemResponses[409],
  },
});

export function createOpenApiDocument(): OpenAPIObject {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Building Energy Codex Agent API',
      version: PUBLIC_API_VERSION,
      description: '由 packages/contracts 的 Zod schema 生成；禁止手工维护并行契约。',
    },
    servers: [{ url: '/', description: '本机服务' }],
  });
}
