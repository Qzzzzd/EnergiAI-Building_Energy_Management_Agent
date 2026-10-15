import {
  CancelTurnResponseSchema,
  CreateSessionResponseSchema,
  DeleteSessionResponseSchema,
  ListSessionsResponseSchema,
  ModelsResponseSchema,
  PUBLIC_API_VERSION,
  ProblemDetailsSchema,
  SessionDetailResponseSchema,
  SseEventSchema,
  SubmitMessageResponseSchema,
  UpdateSessionResponseSchema,
  UpdateQuestionDraftResponseSchema,
  UploadBatchResponseSchema,
  type ArtifactRef,
  type ArtifactResource,
  type SessionResource,
  type SseEvent,
} from '@building-energy/contracts';
import type {
  ActivityItem,
  Artifact,
  ArtifactRefView,
  BusinessEvent,
  ExecutionPlanView,
  Message,
  ModelOption,
  ProblemDetails,
  QuestionSet,
  ReasoningLevel,
  ResultReference,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SkillJobView,
  TurnStatus,
  TurnView,
  UploadSnapshot,
} from '../domain';

export class ApiProblem extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail || problem.title);
    this.name = 'ApiProblem';
    this.problem = problem;
  }
}

export interface EventSubscription {
  close(): void;
}

export interface ApiClient {
  listModels(signal?: AbortSignal): Promise<ModelOption[]>;
  listSessions(
    options?: { search?: string; archived?: boolean },
    signal?: AbortSignal,
  ): Promise<SessionSummary[]>;
  createSession(input: {
    model: string;
    reasoning: ReasoningLevel;
    idempotencyKey: string;
  }): Promise<SessionDetail>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<SessionDetail>;
  updateSession(
    sessionId: string,
    input: {
      title?: string;
      archived?: boolean;
      model?: string;
      reasoning?: ReasoningLevel;
    },
  ): Promise<SessionSummary>;
  deleteSession(sessionId: string, idempotencyKey: string): Promise<void>;
  upload(sessionId: string, files: File[], idempotencyKey: string): Promise<UploadSnapshot[]>;
  sendMessage(
    sessionId: string,
    input: {
      content: string;
      sourceRefs: string[];
      answers?: Record<string, string>;
      questionSetId?: string;
      idempotencyKey: string;
    },
  ): Promise<{ turnId: string }>;
  saveQuestionDraft(
    sessionId: string,
    questionSetId: string,
    draft: Record<string, string>,
  ): Promise<void>;
  cancel(sessionId: string, idempotencyKey: string): Promise<void>;
  subscribe(
    sessionId: string,
    afterEventId: number,
    handlers: {
      onEvent(event: BusinessEvent): void;
      onConnection(connected: boolean): void;
      onError(error: Error): void;
    },
  ): EventSubscription;
}

interface ContractSchema<T> {
  parse(value: unknown): T;
}

const apiVersion = PUBLIC_API_VERSION;

function randomKey(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function internalProblem(detail: string, correlationId = 'client-contract'): ProblemDetails {
  return {
    type: 'about:blank',
    title: '响应契约验证失败',
    status: 502,
    code: 'UNEXPECTED_RESPONSE',
    detail,
    correlationId,
    recovery: '运行 ./scripts/doctor 并检查前后端契约版本。',
  };
}

async function parseProblem(response: Response): Promise<ProblemDetails> {
  try {
    const raw: unknown = await response.json();
    const parsed = ProblemDetailsSchema.parse(raw);
    const recovery = parsed.recovery_actions?.map((action) => action.label).join('；');
    return {
      type: parsed.type,
      title: parsed.title,
      status: parsed.status,
      code: parsed.code,
      detail: parsed.detail,
      correlationId: parsed.correlation_id,
      ...(recovery ? { recovery } : {}),
    };
  } catch {
    return {
      type: 'about:blank',
      title: '请求失败',
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      detail: `服务返回了无法识别的响应（HTTP ${response.status}）`,
      correlationId: response.headers.get('x-correlation-id') ?? 'unknown',
    };
  }
}

async function request<T>(path: string, schema: ContractSchema<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...init?.headers,
    },
  });
  if (!response.ok) throw new ApiProblem(await parseProblem(response));
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new ApiProblem(internalProblem(`服务响应不是 JSON：${path}`));
  }
  try {
    return schema.parse(raw);
  } catch {
    throw new ApiProblem(internalProblem(`服务响应不符合共享 Zod 契约：${path}`));
  }
}

function resultKind(artifactType: string): ResultReference['kind'] {
  if (/quality/i.test(artifactType)) return 'quality';
  if (/forecast|evaluation|model/i.test(artifactType)) return 'forecast';
  return 'generic';
}

function artifactTitle(artifactType: string): string {
  if (/building-energy\.report|report-generation/i.test(artifactType)) return '建筑能源专业分析报告';
  const kind = resultKind(artifactType);
  if (kind === 'quality') return '数据质量结论';
  if (kind === 'forecast') return '负荷预测结论';
  return '分析结果';
}

function artifactSummary(resource: ArtifactResource): string {
  const candidates = ['conclusion', 'message', 'summary', 'overview'];
  for (const key of candidates) {
    const value = resource.summary[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return resource.status === 'partial'
    ? '结果已通过合同校验，但包含需要关注的部分状态。'
    : '结果已通过合同与完整性校验。';
}

function parseEventId(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function mapArtifactRef(resource: ArtifactRef): ArtifactRefView {
  return {
    artifactId: resource.artifact_id,
    artifactType: resource.artifact_type,
    status: resource.status,
    manifestUrl: resource.manifest_url,
  };
}

function mapExecutionPlan(plan: {
  plan_id: string;
  title?: string | undefined;
  nodes: Array<{
    id: string;
    title: string;
    skill_name: string;
    depends_on: string[];
    parallel_group?: string | undefined;
  }>;
}): ExecutionPlanView {
  return {
    planId: plan.plan_id,
    ...(plan.title ? { title: plan.title } : {}),
    nodes: plan.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      skillName: node.skill_name,
      dependsOn: node.depends_on,
      ...(node.parallel_group ? { parallelGroup: node.parallel_group } : {}),
    })),
  };
}

function mapSkillJob(
  resource: ReturnType<typeof SessionDetailResponseSchema.parse>['skill_jobs'][number],
): SkillJobView {
  return {
    turnId: resource.turn_id,
    skillName: resource.skill_name,
    jobId: resource.job_id,
    status: resource.status,
    ...(resource.stage ? { stage: resource.stage } : {}),
    ...(resource.progress ? { progress: resource.progress } : {}),
    warnings: resource.warnings ?? [],
    ...(resource.result_refs ? { resultRefs: resource.result_refs.map(mapArtifactRef) } : {}),
  };
}

function mapArtifact(resource: ArtifactResource, turnId: string): Artifact {
  return {
    id: resource.artifact_id,
    turnId,
    artifactType: resource.artifact_type,
    status: resource.status,
    producer: {
      skillName: resource.producer.skill_name,
      jobId: resource.producer.job_id,
    },
    summary: resource.summary,
    warnings: resource.warnings,
    files: resource.files.map((file, index) => ({
      id: `${resource.artifact_id}:${index}`,
      name: file.name,
      role: file.role,
      mediaType: file.media_type,
      sizeBytes: file.size_bytes,
      sha256: file.sha256,
      contentUrl: file.content_url,
    })),
  };
}

function mapSessionStatus(
  value: SessionResource['status'],
  latestTurn?: TurnStatus,
): SessionStatus {
  if (value === 'empty') return 'idle';
  if (value === 'deleting') return 'deleting';
  if (value === 'running') return 'running';
  if (value === 'needs_input') return 'needs_input';
  if (latestTurn === 'queued' || latestTurn === 'cancelling') return 'running';
  return latestTurn ?? 'idle';
}

function mapSessionSummary(resource: SessionResource, latestTurn?: TurnStatus): SessionSummary {
  return {
    id: resource.session_id,
    title: resource.title,
    status: mapSessionStatus(resource.status, latestTurn),
    model: resource.model,
    reasoning: resource.reasoning_level,
    modelLocked: resource.model_locked,
    archived: resource.archived,
    updatedAt: resource.updated_at,
    preview: '',
  };
}

function mapQuestionSet(
  resource: ReturnType<typeof SessionDetailResponseSchema.parse>['pending_question_set'],
): QuestionSet | undefined {
  if (!resource) return undefined;
  return {
    id: resource.question_set_id,
    turnId: resource.turn_id,
    status: resource.status,
    questions: resource.questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.options,
      allowFreeText: question.allow_free_text,
      required: question.required,
    })),
    draft: Object.fromEntries(
      resource.draft_answers.map((answer) => [answer.question_id, answer.answer]),
    ),
  };
}

type TurnProblemResource = NonNullable<
  ReturnType<typeof SessionDetailResponseSchema.parse>['turns'][number]['problem']
>;

function mapTurnProblem(resource: TurnProblemResource): ProblemDetails {
  const recovery = resource.recovery_actions?.map((action) => action.label).join('；');
  return {
    type: resource.type,
    title: resource.title,
    status: resource.status,
    detail: resource.detail,
    code: resource.code,
    correlationId: resource.correlation_id,
    ...(recovery ? { recovery } : {}),
  };
}

function mapSessionDetail(
  response: ReturnType<typeof SessionDetailResponseSchema.parse>,
): SessionDetail {
  const artifactTurn = new Map<string, string>();
  for (const turn of response.turns) {
    for (const ref of turn.result_refs) artifactTurn.set(ref.artifact_id, turn.turn_id);
  }
  const artifacts = response.artifacts.map((artifact) =>
    mapArtifact(artifact, artifactTurn.get(artifact.artifact_id) ?? ''),
  );
  const artifactById = new Map(
    response.artifacts.map((artifact) => [artifact.artifact_id, artifact]),
  );
  const messages: Message[] = response.messages.map((message) => ({
    id: message.message_id,
    turnId: message.turn_id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at,
    sourceRefs: message.source_refs,
  }));
  const turns: TurnView[] = response.turns.map((turn) => ({
    id: turn.turn_id,
    status: turn.status,
    startedAt: turn.started_at ?? response.session.created_at,
    ...(turn.finished_at ? { finishedAt: turn.finished_at } : {}),
    ...(turn.problem ? { problem: mapTurnProblem(turn.problem) } : {}),
    messages: messages.filter((message) => message.turnId === turn.turn_id),
    activities: [],
    ...(turn.execution_plan ? { executionPlan: mapExecutionPlan(turn.execution_plan) } : {}),
    results: turn.result_refs.map((ref) => {
      const artifact = artifactById.get(ref.artifact_id);
      return {
        artifactId: ref.artifact_id,
        title: artifactTitle(ref.artifact_type),
        artifactType: ref.artifact_type,
        manifestUrl: ref.manifest_url,
        kind: resultKind(ref.artifact_type),
        status: ref.status,
        summary: artifact ? artifactSummary(artifact) : '结果索引已登记，详情正在恢复。',
      };
    }),
  }));
  const pendingQuestionSet = mapQuestionSet(response.pending_question_set);
  if (pendingQuestionSet) {
    const turn = turns.find((candidate) => candidate.id === pendingQuestionSet.turnId);
    if (turn) turn.questionSet = pendingQuestionSet;
  }
  const latestTurn = turns.at(-1)?.status;
  return {
    ...mapSessionSummary(response.session, latestTurn),
    createdAt: response.session.created_at,
    lastEventId: parseEventId(response.last_event_id),
    turns,
    uploads: response.sources.map((source) => ({
      id: source.source_ref,
      sourceRef: source.source_ref,
      name: source.original_name,
      sizeBytes: source.size_bytes,
      sha256: source.sha256,
      mediaType: source.media_type,
    })),
    artifacts,
    skillJobs: response.skill_jobs.map(mapSkillJob),
    ...(pendingQuestionSet ? { activeQuestionSet: pendingQuestionSet } : {}),
    disclosure:
      '删除会移除本应用的会话映射、上传和 Artifact；Codex 主机私有 thread 文件不属于本应用删除范围。',
  };
}

function activityStatus(value: string): ActivityItem['status'] {
  if (value === 'queued') return 'queued';
  if (value === 'in_progress') return 'running';
  if (
    value === 'needs_input' ||
    value === 'completed' ||
    value === 'partial' ||
    value === 'failed' ||
    value === 'cancelling' ||
    value === 'cancelled' ||
    value === 'interrupted'
  ) {
    return value;
  }
  return 'pending';
}

function mapEvent(event: SseEvent): BusinessEvent {
  let payload: Record<string, unknown> = { data: event.data };
  switch (event.type) {
    case 'turn.started':
      payload = {
        activity: {
          id: `turn:${event.turn_id}`,
          kind: 'agent',
          title: 'Codex Turn',
          model: event.data.model,
          reasoning: event.data.reasoning_level,
          status: 'running',
        },
      };
      break;
    case 'execution.plan':
      payload = {
        executionPlan: mapExecutionPlan(event.data.plan),
      };
      break;
    case 'plan.updated':
      payload = {
        activities: event.data.items.map((item) => ({
          id: item.id,
          kind: 'plan',
          title: item.step,
          status: activityStatus(item.status),
        })),
      };
      break;
    case 'agent.activity':
      payload = {
        activity: {
          id: event.data.activity_id,
          kind: event.data.kind,
          title: event.data.summary,
          summary: event.data.detail,
          status: activityStatus(event.data.status),
        },
      };
      break;
    case 'skill.started':
    case 'skill.progress':
    case 'skill.completed':
      payload = {
        activity: {
          id: `skill:${event.data.job_id}`,
          kind: 'skill',
          title: event.data.skill_name,
          skillName: event.data.skill_name,
          jobId: event.data.job_id,
          ...('stage' in event.data ? { stage: event.data.stage } : {}),
          status:
            event.type === 'skill.completed'
              ? event.data.status === 'partial'
                ? 'partial'
                : 'completed'
              : 'running',
          ...('status' in event.data && event.type === 'skill.completed'
            ? { outcome: event.data.status }
            : {}),
          ...('progress' in event.data ? { progress: event.data.progress } : {}),
          ...(event.type === 'skill.completed'
            ? { resultRefs: event.data.result_refs.map(mapArtifactRef) }
            : {}),
          ...('warnings' in event.data
            ? {
                warnings: event.data.warnings,
                ...(event.data.warnings.length ? { summary: event.data.warnings.join('；') } : {}),
              }
            : {}),
        },
      };
      break;
    case 'input.required':
      payload = {
        questionSet: {
          id: event.data.question_set_id,
          turnId: event.turn_id,
          status: 'pending',
          questions: event.data.questions.map((question) => ({
            id: question.id,
            question: question.question,
            options: question.options,
            allowFreeText: question.allow_free_text,
            required: question.required,
          })),
          draft: {},
        },
      };
      break;
    case 'assistant.message':
      payload = {
        messageId: event.data.message_id,
        content: event.data.content,
        resultRefs: event.data.result_refs,
      };
      break;
    case 'turn.completed':
    case 'turn.partial':
      payload = {
        activity: {
          id: `turn:${event.turn_id}`,
          kind: 'agent',
          title: '本次分析',
          status: event.type === 'turn.partial' ? 'partial' : 'completed',
          ...(event.data.usage
            ? {
                tokens: {
                  input: event.data.usage.input_tokens,
                  cached: event.data.usage.cached_input_tokens,
                  output: event.data.usage.output_tokens,
                },
              }
            : {}),
        },
      };
      break;
    case 'turn.failed':
      payload = {
        problem: mapTurnProblem(event.data.problem),
        activity: {
          id: `turn:${event.turn_id}`,
          kind: 'error',
          title: '本次分析失败',
          summary: event.data.problem.detail,
          status: 'failed',
        },
      };
      break;
    case 'turn.cancelled':
      payload = {
        activity: {
          id: `turn:${event.turn_id}`,
          kind: 'warning',
          title: '本次分析已取消',
          summary: event.data.reason,
          status: 'cancelled',
        },
      };
      break;
    case 'turn.interrupted':
      payload = {
        problem: mapTurnProblem(event.data.problem),
        activity: {
          id: `turn:${event.turn_id}`,
          kind: 'error',
          title: '本次分析已中断',
          summary: event.data.problem.detail,
          status: 'interrupted',
        },
      };
      break;
    case 'artifact.created':
      payload = {
        artifactRef: event.data.artifact,
        activity: {
          id: `artifact:${event.data.artifact.artifact_id}`,
          kind: 'artifact',
          title: event.data.artifact.artifact_type,
          summary: event.data.artifact.status,
          status: 'completed',
        },
      };
      break;
    default:
      payload = {};
  }
  return {
    protocolVersion: event.protocol_version,
    eventId: Number(event.event_id),
    sessionId: event.session_id,
    turnId: event.turn_id,
    type: event.type,
    occurredAt: event.occurred_at,
    payload,
  };
}

const eventNames: SseEvent['type'][] = [
  'turn.started',
  'execution.plan',
  'plan.updated',
  'agent.activity',
  'skill.started',
  'skill.progress',
  'skill.completed',
  'input.required',
  'artifact.created',
  'assistant.message',
  'turn.completed',
  'turn.partial',
  'turn.failed',
  'turn.cancelled',
  'turn.interrupted',
];

export function createApiClient(): ApiClient {
  const getSession = async (sessionId: string, signal?: AbortSignal) => {
    const response = await request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      SessionDetailResponseSchema,
      signal ? { signal } : undefined,
    );
    return mapSessionDetail(response);
  };

  return {
    async listModels(signal) {
      const response = await request(
        '/api/v1/models',
        ModelsResponseSchema,
        signal ? { signal } : undefined,
      );
      return response.models.map((model) => ({
        id: model.id,
        displayName: model.display_name,
        reasoningLevels: model.reasoning_levels,
        available: model.availability === 'available',
        ...(model.unavailable_reason ? { unavailableReason: model.unavailable_reason } : {}),
        isDefault: model.id === response.default_model,
      }));
    },

    async listSessions(options, signal) {
      const search = new URLSearchParams();
      if (options?.search?.trim()) search.set('search', options.search.trim());
      search.set('archived', String(options?.archived ?? false));
      const response = await request(
        `/api/v1/sessions${search.size ? `?${search}` : ''}`,
        ListSessionsResponseSchema,
        signal ? { signal } : undefined,
      );
      return response.sessions.map((session) => mapSessionSummary(session));
    },

    async createSession(input) {
      const response = await request('/api/v1/sessions', CreateSessionResponseSchema, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
        },
        body: JSON.stringify({
          api_version: apiVersion,
          model: input.model,
          reasoning_level: input.reasoning,
        }),
      });
      return getSession(response.session.session_id);
    },

    getSession,

    async updateSession(sessionId, input) {
      const { reasoning, ...sessionFields } = input;
      const response = await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        UpdateSessionResponseSchema,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_version: apiVersion,
            ...sessionFields,
            ...(reasoning !== undefined ? { reasoning_level: reasoning } : {}),
          }),
        },
      );
      return mapSessionSummary(response.session);
    },

    async deleteSession(sessionId, idempotencyKey) {
      await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        DeleteSessionResponseSchema,
        {
          method: 'DELETE',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ api_version: apiVersion, confirm_session_id: sessionId }),
        },
      );
    },

    async upload(sessionId, files, idempotencyKey) {
      const body = new FormData();
      body.append('api_version', apiVersion);
      for (const file of files) body.append('files', file, file.name);
      const response = await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/uploads`,
        UploadBatchResponseSchema,
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body },
      );
      return response.sources.map((source) => ({
        id: source.source_ref,
        sourceRef: source.source_ref,
        name: source.original_name,
        sizeBytes: source.size_bytes,
        sha256: source.sha256,
        mediaType: source.media_type,
      }));
    },

    async sendMessage(sessionId, input) {
      const body = input.questionSetId
        ? {
            api_version: apiVersion,
            kind: 'question_answers',
            question_set_id: input.questionSetId,
            answers: Object.entries(input.answers ?? {}).map(([question_id, answer]) => ({
              question_id,
              answer,
            })),
          }
        : {
            api_version: apiVersion,
            kind: 'message',
            content: input.content,
            source_refs: input.sourceRefs,
          };
      const response = await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
        SubmitMessageResponseSchema,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': input.idempotencyKey,
          },
          body: JSON.stringify(body),
        },
      );
      return { turnId: response.turn.turn_id };
    },

    async saveQuestionDraft(sessionId, questionSetId, draft) {
      await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/question-sets/${encodeURIComponent(questionSetId)}/draft`,
        UpdateQuestionDraftResponseSchema,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            api_version: apiVersion,
            draft_answers: Object.entries(draft).map(([question_id, answer]) => ({
              question_id,
              answer,
            })),
          }),
        },
      );
    },

    async cancel(sessionId, idempotencyKey) {
      await request(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,
        CancelTurnResponseSchema,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({ api_version: apiVersion, reason: '用户从 Web 主动取消' }),
        },
      );
    },

    subscribe(sessionId, afterEventId, handlers) {
      const search = new URLSearchParams();
      if (afterEventId > 0) search.set('after_event_id', String(afterEventId));
      const source = new EventSource(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/events${search.size ? `?${search}` : ''}`,
      );
      source.onopen = () => handlers.onConnection(true);
      const receive = (message: MessageEvent<string>) => {
        try {
          const parsed = SseEventSchema.parse(JSON.parse(message.data));
          handlers.onEvent(mapEvent(parsed));
        } catch {
          handlers.onError(new Error('收到不符合共享 Zod 契约的活动事件'));
        }
      };
      source.onmessage = receive;
      for (const eventName of eventNames) {
        source.addEventListener(eventName, receive as EventListener);
      }
      source.onerror = () => handlers.onConnection(false);
      return { close: () => source.close() };
    },
  };
}

export const idempotencyKey = randomKey;
