import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  SSE_PROTOCOL_VERSION,
  type AgentTurnEnvelope,
  type ArtifactRef,
  type Question,
  type QuestionAnswer,
  type ReasoningLevel,
  type SkillEvent,
  type SseEvent,
} from '@building-energy/contracts';

import { ArtifactService } from './artifacts.js';
import { CodexAdapterError } from './codex-adapter.js';
import { assertAllowedModel, type ModelCatalog } from './config.js';
import {
  hashJson,
  problem,
  Repository,
  RepositoryError,
  type SkillJobRow,
  type TurnRow,
} from './database.js';
import { CodexEventProjector, SkillProtocolProjectionError } from './event-projector.js';
import { redactText } from './redaction.js';
import type { ActiveExecution, CodexAdapter, PersistableEvent, ServerConfig } from './types.js';
import { WorkspaceManager } from './workspace.js';

export class EventBus extends EventEmitter {
  publish(event: SseEvent): void {
    this.emit(event.session_id, event);
  }

  publishAll(events: SseEvent[]): void {
    for (const event of events) this.publish(event);
  }
}

export class SessionRuntime {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly deletingSessions = new Set<string>();

  constructor(
    readonly repository: Repository,
    readonly workspaces: WorkspaceManager,
    readonly artifacts: ArtifactService,
    readonly adapter: CodexAdapter,
    readonly models: ModelCatalog,
    readonly config: ServerConfig,
    readonly events = new EventBus(),
  ) {}

  async initialize(): Promise<void> {
    await this.workspaces.initialize();
    this.repository.migrate();
    await this.workspaces.reconcileTrash(
      this.repository.listSessions(undefined, 10_000).map((session) => session.id),
    );
    for (const turn of this.repository.activeTurns()) {
      const recovery = problem(
        'TURN_INTERRUPTED',
        409,
        '执行被服务重启中断',
        '服务无法证明重启前的 Codex Turn 或 Skill 作业仍在运行，已保留历史并标记为 interrupted。',
        randomUUID(),
      );
      this.events.publishAll(this.repository.interruptTurn(turn.id, recovery));
    }
  }

  async createSession(input: {
    title?: string;
    model: string;
    reasoning: ReasoningLevel;
    idempotencyKey?: string;
  }) {
    assertAllowedModel(this.models, input.model, input.reasoning);
    const requestHash = hashJson(input);
    if (input.idempotencyKey) {
      const replay = this.repository.getIdempotency<Record<string, unknown>>(
        'create-session',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return { response: replay, replayed: true };
    }
    const sessionId = randomUUID();
    const paths = await this.workspaces.createSession(sessionId);
    try {
      const session = this.repository.createSession({
        id: sessionId,
        title: input.title ?? '新会话',
        model: input.model,
        reasoning: input.reasoning,
        workspace: paths.workspace,
      });
      const response = { api_version: '1.0', session: this.repository.sessionResource(session) };
      if (input.idempotencyKey) {
        this.repository.recordIdempotency(
          'create-session',
          input.idempotencyKey,
          requestHash,
          response,
        );
      }
      return { response, replayed: false };
    } catch (error) {
      this.repository.rollbackSessionCreate(sessionId, input.idempotencyKey);
      await this.workspaces.deleteSession(sessionId);
      throw error;
    }
  }

  async rollbackSessionCreate(sessionId: string, idempotencyKey?: string): Promise<void> {
    this.repository.rollbackSessionCreate(sessionId, idempotencyKey);
    await this.workspaces.deleteSession(sessionId);
  }

  updateSession(
    sessionId: string,
    input: {
      title?: string;
      archived?: boolean;
      model?: string;
      reasoning?: ReasoningLevel;
    },
  ) {
    if (input.model !== undefined && input.reasoning !== undefined) {
      assertAllowedModel(this.models, input.model, input.reasoning);
    }
    return this.repository.updateSession(sessionId, input);
  }

  submit(input: {
    sessionId: string;
    idempotencyKey: string;
    content?: string;
    sourceRefs?: string[];
    questionSetId?: string;
    answers?: QuestionAnswer[];
  }): { turn: TurnRow; replayed: boolean } {
    if (this.deletingSessions.has(input.sessionId)) {
      throw new RepositoryError('SESSION_STATE_INVALID', '会话正在删除。');
    }
    const content = input.questionSetId
      ? buildAnswersMessage(input.questionSetId, input.answers ?? [])
      : (input.content ?? '');
    if (input.questionSetId) {
      const resumed = this.repository.resumeQuestionSet({
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        questionSetId: input.questionSetId,
        answers: input.answers ?? [],
        content,
      });
      if (!resumed.replayed) {
        this.launch(
          resumed.turn,
          content,
          this.repository.sourceRefsForTurn(input.sessionId, resumed.turn.id),
        );
      }
      return { turn: this.repository.requireTurn(resumed.turn.id), replayed: resumed.replayed };
    }
    const created = this.repository.createTurn({
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      content,
      sourceRefs: input.sourceRefs ?? [],
    });
    if (!created.replayed) this.launch(created.turn, content, input.sourceRefs ?? []);
    return { turn: this.repository.requireTurn(created.turn.id), replayed: created.replayed };
  }

  async cancel(sessionId: string, idempotencyKey: string, reason?: string) {
    const active = this.repository.findActiveTurn(sessionId);
    const requestHash = hashJson({ sessionId, reason });
    const replay = this.repository.getIdempotency<Record<string, unknown>>(
      `cancel:${sessionId}`,
      idempotencyKey,
      requestHash,
    );
    if (replay) return { ...replay, replayed: true };
    if (!active) throw new RepositoryError('SESSION_STATE_INVALID', '会话没有可取消的 Turn。');
    this.repository.markCancelling(active.id);
    const execution = this.active.get(sessionId);
    if (!execution || execution.turnId !== active.id) {
      throw new CancellationError('无法确认活动进程归属，未发布 cancelled。');
    }
    execution.controller.abort(reason ?? 'cancelled by user');
    const stopped = await waitFor(execution.done, this.config.cancelTimeoutMs);
    if (!stopped || this.repository.requireTurn(active.id).status !== 'cancelled') {
      throw new CancellationError('执行未在超时内确认停止，未发布 cancelled。');
    }
    const response = {
      api_version: '1.0',
      turn: this.repository.turnResource(this.repository.requireTurn(active.id)),
      replayed: false,
    };
    this.repository.recordIdempotency(`cancel:${sessionId}`, idempotencyKey, requestHash, response);
    return response;
  }

  async deleteSession(sessionId: string, confirmSessionId: string, idempotencyKey: string) {
    const requestHash = hashJson({ sessionId, confirmSessionId });
    const replay = this.repository.getIdempotency<Record<string, unknown>>(
      'delete-session',
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;
    if (sessionId !== confirmSessionId) {
      throw new RepositoryError('SESSION_STATE_INVALID', '删除确认与会话 ID 不一致。');
    }
    this.repository.requireSession(sessionId);
    this.deletingSessions.add(sessionId);
    try {
      this.repository.markSessionDeleting(sessionId);
      const active = this.repository.findActiveTurn(sessionId);
      if (active) {
        const execution = this.active.get(sessionId);
        if (!execution) throw new CancellationError('删除前无法确认活动执行已停止。');
        this.repository.markCancelling(active.id);
        execution.controller.abort('session deletion');
        if (!(await waitFor(execution.done, this.config.cancelTimeoutMs))) {
          throw new CancellationError('删除前活动执行未在超时内停止。');
        }
      }
      const response = { api_version: '1.0', deleted_session_id: sessionId };
      const tombstone = await this.workspaces.detachSession(sessionId);
      try {
        this.repository.deleteSession(sessionId);
        this.repository.recordIdempotency('delete-session', idempotencyKey, requestHash, response);
      } catch (error) {
        await this.workspaces.restoreDetachedSession(sessionId, tombstone);
        throw error;
      }
      await this.workspaces.finalizeDetachedSession(tombstone).catch(() => undefined);
      return response;
    } finally {
      this.deletingSessions.delete(sessionId);
    }
  }

  appendPublicReadActivity(sessionId: string, summary: string, detail?: string): SseEvent | null {
    const turn = this.repository.findActiveTurn(sessionId);
    if (!turn) return null;
    const event = this.repository.appendEvent({
      protocol_version: SSE_PROTOCOL_VERSION,
      session_id: sessionId,
      turn_id: turn.id,
      type: 'agent.activity',
      data: {
        activity_id: `public-read:${randomUUID()}`,
        kind: 'web_search',
        status: 'completed',
        summary: redactText(summary, 4_000, 20),
        ...(detail ? { detail: redactText(detail, 8_000, 40) } : {}),
      },
    });
    this.events.publish(event);
    return event;
  }

  async waitForIdle(sessionId: string): Promise<void> {
    const execution = this.active.get(sessionId);
    if (execution) await execution.done;
  }

  async shutdown(): Promise<void> {
    const executions = [...this.active.values()];
    for (const execution of executions) execution.controller.abort('server shutdown');
    await Promise.all(
      executions.map((execution) => waitFor(execution.done, this.config.cancelTimeoutMs)),
    );
  }

  private launch(turn: TurnRow, content: string, sourceRefs: string[]): void {
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.active.set(turn.sessionId, { turnId: turn.id, controller, done });
    queueMicrotask(() => {
      void this.execute(turn, content, sourceRefs, controller)
        .catch(() => undefined)
        .finally(() => {
          const current = this.active.get(turn.sessionId);
          if (current?.turnId === turn.id) this.active.delete(turn.sessionId);
          resolveDone();
        });
    });
  }

  private async execute(
    turn: TurnRow,
    content: string,
    sourceRefs: string[],
    controller: AbortController,
  ): Promise<void> {
    const startedAt = Date.now();
    let pausedForInput = false;
    let watchdogTriggered = false;
    let watchdog: WatchdogHandle | undefined;
    try {
      const { event } = this.repository.startTurn(turn.id);
      this.events.publish(event);
      const session = this.repository.requireSession(turn.sessionId);
      const sources = this.repository.uploadsByRefs(turn.sessionId, sourceRefs).map((source) => ({
        sourceRef: source.sourceRef,
        relativePath: this.workspaces.relativeSourcePath(turn.sessionId, source.relativePath),
        originalName: source.originalName,
      }));
      const runtimeContext = this.buildRuntimeContext(turn.sessionId, turn.id);
      const projector = new CodexEventProjector(
        turn.sessionId,
        turn.id,
        Boolean(turn.executionPlan),
      );
      watchdog = this.startWatchdog(turn, controller, () => {
        watchdogTriggered = true;
        controller.abort('codex watchdog: no observable progress');
      });
      const result = await this.adapter.runTurn({
        sessionId: turn.sessionId,
        turnId: turn.id,
        threadId: session.threadId,
        workspacePath: session.workspace,
        model: session.model,
        reasoningLevel: session.reasoning,
        content,
        sources,
        runtimeContext,
        signal: controller.signal,
        onThreadStarted: async (threadId) =>
          this.repository.persistThreadId(turn.sessionId, threadId),
        onEvent: async (sdkEvent) => {
          const projected = projector.project(sdkEvent);
          for (const plan of projected.executionPlans) {
            const executionPlanEvent = this.repository.persistExecutionPlan(turn.id, plan);
            if (executionPlanEvent) this.events.publish(executionPlanEvent);
          }
          for (const projectedEvent of projected.events) {
            this.events.publish(this.repository.appendEvent(projectedEvent));
          }
          for (const skillEvent of projected.skillEvents) {
            await this.persistSkillEvent(turn, projector, skillEvent);
            if (skillEvent.kind === 'needs_input') {
              const inputEvents = this.repository.requireInput({
                turnId: turn.id,
                questions: redactQuestions(skillEvent.questions),
              });
              pausedForInput = true;
              this.events.publishAll(inputEvents);
              controller.abort('skill needs input');
              break;
            }
          }
          watchdog?.observe();
        },
      });
      if (controller.signal.aborted) throw new CodexAdapterError('ABORTED', 'Turn 已取消。');
      this.repository.persistThreadId(turn.sessionId, result.threadId);
      const terminal = await this.persistEnvelope(
        turn,
        result.envelope,
        Date.now() - startedAt,
        result.usage,
      );
      this.events.publishAll(terminal);
    } catch (error) {
      if (pausedForInput) return;
      if (watchdogTriggered) {
        const interruption = problem(
          'TURN_INTERRUPTED',
          409,
          '执行长时间无进展',
          'Codex 在受控观察窗口内没有新的流事件、Skill 作业变化或已验证 Artifact 变化，服务已停止本次执行。可重试该任务。',
          randomUUID(),
        );
        this.events.publishAll(this.repository.interruptTurn(turn.id, interruption));
        return;
      }
      if (
        controller.signal.aborted ||
        (error instanceof CodexAdapterError && error.code === 'ABORTED')
      ) {
        this.events.publishAll(this.repository.markCancelled(turn.id, '用户取消了当前执行。'));
        return;
      }
      const failure = mapTurnFailure(error, randomUUID());
      this.events.publishAll(this.repository.failTurn(turn.id, failure));
    } finally {
      watchdog?.stop();
    }
  }

  private async persistSkillEvent(
    turn: TurnRow,
    projector: CodexEventProjector,
    skillEvent: SkillEvent,
  ): Promise<void> {
    const status = mapSkillStatus(skillEvent);
    if (status) {
      this.repository.upsertSkillJob({
        id: randomUUID(),
        sessionId: turn.sessionId,
        turnId: turn.id,
        skillName: skillEvent.skill_name,
        externalJobId: skillEvent.job_id,
        status,
        metadata: skillJobMetadata(skillEvent),
      });
    }
    for (const projected of projector.projectSkillEvent(skillEvent)) {
      this.events.publish(this.repository.appendEvent(projected));
    }
    if (skillEvent.kind === 'artifact') {
      const registered = await this.artifacts.registerManifest(
        turn.sessionId,
        turn.id,
        skillEvent.manifest_relative_path,
      );
      this.repository.attachResultRef(turn.id, registered.ref);
      const artifactEvent = this.repository.appendEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: 'artifact.created',
        data: { artifact: registered.ref },
      } as PersistableEvent);
      this.events.publish(artifactEvent);
    }
  }

  private buildRuntimeContext(sessionId: string, turnId: string): string {
    const turn = this.repository.requireSessionTurn(sessionId, turnId);
    // A follow-up turn in the same Codex thread must be able to reuse a
    // verified Bundle produced by the preceding turn (for example parsing ->
    // quality). Keep the index session-scoped, but bounded and metadata-only.
    const jobs = this.repository.skillJobsForSession(sessionId).slice(-128).map(compactSkillJob);
    const artifacts = this.artifacts
      .compactIndex(sessionId)
      .slice(-64)
      .map((artifact) => ({
        ...artifact,
        producer: compactValue(artifact.producer),
        summary: compactValue(artifact.summary) as Record<string, unknown>,
        warnings: artifact.warnings.slice(0, 8),
      }));
    const activeJobs = jobs.filter((job) =>
      ['queued', 'running', 'cancelling', 'needs_input'].includes(job.status),
    );
    const terminalArtifacts = artifacts.filter((artifact) =>
      ['succeeded', 'partial'].includes(artifact.status),
    );
    const allowedNextSteps = [
      '仅使用 verified_artifacts 中的 Artifact ref；需要文件时读取对应 content_url 的单个必要文件。',
      '优先查询并复用已有 Skill job_id；不要重复启动已进入终态的 job。',
      ...(activeJobs.length > 0
        ? ['继续观察已有 queued/running job 的状态，只有实际状态变化才报告进展。']
        : []),
      ...(terminalArtifacts.length > 0 ? ['复用已验证的终态 Artifact，不重新读取完整报告。'] : []),
      ...(turn.executionPlan
        ? ['此 Turn 已有 execution.plan：继续该计划，不要声明第二个计划或创建恢复任务。']
        : ['确需新的计算 Skill 时，先输出一次真实 execution.plan，再按依赖启动实际 Skill。']),
    ];
    return JSON.stringify({
      context_version: 1,
      execution_plan: turn.executionPlan,
      verified_artifacts: artifacts,
      skill_jobs: jobs,
      allowed_next_steps: allowedNextSteps,
    });
  }

  private startWatchdog(
    turn: TurnRow,
    controller: AbortController,
    onStall: () => void,
  ): WatchdogHandle {
    const intervalMs = Math.max(
      25,
      this.config.watchdogIntervalMs ?? Math.min(1_000, Math.max(25, this.config.heartbeatMs)),
    );
    const configuredStall = this.config.watchdogStallMs;
    const warningMs = Math.max(
      intervalMs,
      this.config.watchdogWarningMs ??
        (configuredStall !== undefined ? Math.floor(configuredStall / 2) : 30_000),
    );
    const terminationMs = Math.max(
      warningMs,
      this.config.watchdogTerminationMs ?? configuredStall ?? 60_000,
    );
    let stopped = false;
    let triggered = false;
    let warningPublished = false;
    let lastProgressAt = Date.now();
    let fingerprint = this.repository.progressFingerprint(turn.id);
    const activityId = `watchdog:${turn.id}`;
    const publishWarning = () => {
      if (warningPublished) return;
      warningPublished = true;
      const event = this.repository.appendEvent({
        protocol_version: SSE_PROTOCOL_VERSION,
        session_id: turn.sessionId,
        turn_id: turn.id,
        type: 'agent.activity',
        data: {
          activity_id: activityId,
          kind: 'warning',
          status: 'in_progress',
          summary: '暂未收到新的 Codex 输出，正在确认 Skill 作业和 Artifact 是否仍有进展。',
        },
      } as PersistableEvent);
      this.events.publish(event);
    };
    const observe = () => {
      if (stopped) return;
      lastProgressAt = Date.now();
      try {
        fingerprint = this.repository.progressFingerprint(turn.id);
      } catch {
        // The terminal transition owns the database row; the next cleanup
        // stops this observer.  No synthetic progress is emitted here.
      }
      warningPublished = false;
    };
    const timer = setInterval(() => {
      if (stopped || controller.signal.aborted) return;
      if (triggered) return;
      let current: string;
      try {
        current = this.repository.progressFingerprint(turn.id);
      } catch {
        return;
      }
      if (current !== fingerprint) {
        fingerprint = current;
        lastProgressAt = Date.now();
        warningPublished = false;
        return;
      }
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs >= terminationMs) {
        publishWarning();
        triggered = true;
        onStall();
        return;
      }
      if (idleMs >= warningMs) publishWarning();
    }, intervalMs);
    timer.unref();
    return {
      observe,
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async persistEnvelope(
    turn: TurnRow,
    envelope: AgentTurnEnvelope,
    durationMs: number,
    usage?: {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
    },
  ): Promise<SseEvent[]> {
    if (envelope.status === 'needs_input') {
      return this.repository.requireInput({
        turnId: turn.id,
        ...(envelope.message ? { message: redactText(envelope.message, 100_000, 2_000) } : {}),
        questions: redactQuestions(envelope.questions),
      });
    }
    return this.repository.finishTurn({
      turnId: turn.id,
      status: envelope.status,
      message: redactText(envelope.message, 100_000, 2_000),
      // Artifact refs attached by the verifier are authoritative even when
      // the delayed Codex summary omits them.  Envelope refs are still
      // validated by finishTurn against the registered Artifact table.
      resultRefs: mergeArtifactRefs(
        this.repository.requireTurn(turn.id).resultRefs,
        envelope.result_refs as ArtifactRef[],
      ),
      durationMs,
      ...(usage
        ? {
            usage: {
              input_tokens: usage.input_tokens,
              cached_input_tokens: usage.cached_input_tokens,
              output_tokens: usage.output_tokens,
            },
          }
        : {}),
    });
  }
}

export class CancellationError extends Error {}

interface WatchdogHandle {
  observe: () => void;
  stop: () => void;
}

function redactQuestions(questions: Question[]): Question[] {
  return questions.map((question) => ({
    ...question,
    question: redactText(question.question, 2_000, 50),
    options: question.options.map((option) => redactText(option, 500, 10)),
  }));
}

function buildAnswersMessage(questionSetId: string, answers: QuestionAnswer[]): string {
  return [
    `以下是 question_set_id=${questionSetId} 的结构化回答。`,
    JSON.stringify({ question_set_id: questionSetId, answers }),
    '请在同一 thread 中继续原任务，并复用可恢复的 Skill job ID。',
  ].join('\n');
}

function mapSkillStatus(event: SkillEvent): string | null {
  switch (event.kind) {
    case 'started':
    case 'progress':
      return 'running';
    case 'artifact':
      return null;
    case 'needs_input':
      return 'needs_input';
    case 'completed':
      return event.outcome;
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function skillJobMetadata(event: SkillEvent): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    stage: redactText(event.stage, 256, 2),
    warnings: event.warnings.map((warning) => redactText(warning, 2_000, 10)),
  };
  if ('progress' in event && event.progress) metadata.progress = event.progress;
  if (event.kind === 'needs_input') metadata.questions = event.questions;
  if (event.kind === 'completed') metadata.result_refs = event.result_refs;
  if (event.kind === 'failed') metadata.error = event.error;
  if (event.kind === 'cancelled' && event.reason) {
    metadata.reason = redactText(event.reason, 1_000, 10);
  }
  return metadata;
}

function compactSkillJob(job: SkillJobRow): {
  skill_name: string;
  job_id: string;
  status: string;
  metadata: unknown;
} {
  return {
    skill_name: job.skillName,
    job_id: job.externalJobId,
    status: job.status,
    metadata: compactValue(job.metadata),
  };
}

function compactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value, 1_000, 10);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 48)
        .map(([key, item]) => [key, compactValue(item, depth + 1)]),
    );
  }
  return null;
}

function mergeArtifactRefs(existing: ArtifactRef[], incoming: ArtifactRef[]): ArtifactRef[] {
  const merged = [...existing];
  for (const ref of incoming) {
    if (
      !merged.some(
        (candidate) =>
          candidate.artifact_id === ref.artifact_id &&
          candidate.artifact_type === ref.artifact_type &&
          candidate.status === ref.status &&
          candidate.manifest_url === ref.manifest_url,
      )
    ) {
      merged.push(ref);
    }
  }
  return merged;
}

function mapTurnFailure(error: unknown, correlationId: string) {
  if (error instanceof SkillProtocolProjectionError) {
    const protocolReason = redactText(error.message, 1_000, 10);
    return problem(
      'SKILL_PROTOCOL_ERROR',
      500,
      '专业任务格式校验失败',
      `专业任务返回的数据格式无法校验。具体原因：${protocolReason} 本次没有生成结果。请重试；如果连续出现，请检查服务版本。`,
      correlationId,
    );
  }
  if (error instanceof CodexAdapterError) {
    if (error.code === 'UNAUTHENTICATED') {
      return problem(
        'UNAUTHENTICATED',
        503,
        '模型服务未登录',
        '模型服务登录状态不可用，请重新登录 Codex 后重试。',
        correlationId,
      );
    }
    if (error.code === 'MODEL_UNAVAILABLE') {
      return problem(
        'MODEL_UNAVAILABLE',
        503,
        '模型暂时不可用',
        '当前模型暂时无法响应，可能是服务繁忙或额度受限。请稍后重试，或选择其他可用模型。',
        correlationId,
      );
    }
    if (error.code === 'INVALID_OUTPUT') {
      return problem(
        'TURN_FAILED',
        500,
        '模型响应格式异常',
        '模型返回的内容无法验证，本次没有生成结果。请重试；如果连续出现，请检查服务版本。',
        correlationId,
      );
    }
  }

  const detail = error instanceof Error ? error.message : String(error);
  if (/reconnect|request timed out|timed out|timeout|ETIMEDOUT/i.test(detail)) {
    return problem(
      'TURN_FAILED',
      500,
      '模型服务连接超时',
      '模型服务在多次重试后仍未响应，本次没有生成结果。请稍后重试；如果连续发生，请检查网络代理或运行 doctor。',
      correlationId,
    );
  }
  return problem(
    'TURN_FAILED',
    500,
    '暂时无法完成请求',
    '模型服务没有完成本次请求，本次没有生成结果。请稍后重试；如果连续发生，请运行 doctor 检查服务状态。',
    correlationId,
  );
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
