import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { ApiProblem, createApiClient, idempotencyKey, type ApiClient } from '../api/client';
import type {
  ActivityItem,
  Artifact,
  BusinessEvent,
  ExecutionPlanView,
  Message,
  ModelOption,
  ProblemDetails,
  QuestionSet,
  ReasoningLevel,
  SessionDetail,
  SessionStatus,
  SessionSummary,
  SkillJobStatus,
  SkillJobView,
  TurnStatus,
} from '../domain';

interface Notice {
  title: string;
  detail: string;
  recovery?: string;
  correlationId?: string;
}

interface WorkspaceState {
  models: ModelOption[];
  sessions: SessionSummary[];
  archivedSessions: SessionSummary[];
  current: SessionDetail | null;
  selectedModel: string;
  selectedReasoning: ReasoningLevel;
  loading: boolean;
  busy: boolean;
  connected: boolean;
  notice: Notice | null;
  sessionDrawerOpen: boolean;
  activityOpen: boolean;
}

type Action =
  | { type: 'BOOT_START' }
  | {
      type: 'BOOT_READY';
      models: ModelOption[];
      sessions: SessionSummary[];
      archivedSessions: SessionSummary[];
    }
  | { type: 'BUSY'; value: boolean }
  | { type: 'CURRENT'; session: SessionDetail }
  | { type: 'SESSION_UPDATED'; session: SessionSummary }
  | { type: 'REMOVE_CURRENT'; sessionId: string }
  | { type: 'SELECT_MODEL'; model: string; reasoning: ReasoningLevel }
  | { type: 'CONNECTION'; connected: boolean }
  | { type: 'EVENT'; event: BusinessEvent }
  | { type: 'NOTICE'; notice: Notice | null }
  | { type: 'SESSION_DRAWER'; open: boolean }
  | { type: 'ACTIVITY'; open: boolean };

const initialState: WorkspaceState = {
  models: [],
  sessions: [],
  archivedSessions: [],
  current: null,
  selectedModel: '',
  selectedReasoning: 'xhigh',
  loading: true,
  busy: false,
  connected: false,
  notice: null,
  sessionDrawerOpen: false,
  activityOpen: true,
};

function statusForEvent(type: BusinessEvent['type']): TurnStatus | null {
  const values: Partial<Record<BusinessEvent['type'], TurnStatus>> = {
    'turn.started': 'running',
    'input.required': 'needs_input',
    'turn.completed': 'completed',
    'turn.partial': 'partial',
    'turn.failed': 'failed',
    'turn.cancelled': 'cancelled',
    'turn.interrupted': 'interrupted',
  };
  return values[type] ?? null;
}

function isTerminalStatus(status: TurnStatus | SessionStatus): boolean {
  return ['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status);
}

function terminalActivityStatus(type: BusinessEvent['type']): ActivityItem['status'] | null {
  switch (type) {
    case 'turn.completed':
      return 'completed';
    case 'turn.partial':
      return 'partial';
    case 'turn.failed':
      return 'failed';
    case 'turn.interrupted':
      return 'interrupted';
    case 'turn.cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function activityStatus(value: unknown): ActivityItem['status'] {
  if (value === 'succeeded') return 'completed';
  if (
    value === 'pending' ||
    value === 'queued' ||
    value === 'running' ||
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
  if (value === 'in_progress') return 'running';
  return 'pending';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function activityResultRefs(value: unknown): NonNullable<ActivityItem['resultRefs']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((raw) => {
    if (!isRecord(raw)) return [];
    if (
      typeof raw.artifactId !== 'string' ||
      typeof raw.artifactType !== 'string' ||
      typeof raw.manifestUrl !== 'string' ||
      (raw.status !== 'succeeded' && raw.status !== 'partial')
    ) {
      return [];
    }
    const status: 'succeeded' | 'partial' = raw.status === 'partial' ? 'partial' : 'succeeded';
    return [
      {
        artifactId: raw.artifactId,
        artifactType: raw.artifactType,
        status,
        manifestUrl: raw.manifestUrl,
      },
    ];
  });
  return refs.length > 0 ? refs : undefined;
}

function eventMessage(event: BusinessEvent): Message | null {
  if (event.type !== 'assistant.message') return null;
  const content = event.payload.content;
  if (typeof content !== 'string') return null;
  return {
    id:
      typeof event.payload.messageId === 'string'
        ? event.payload.messageId
        : `event-${event.eventId}`,
    turnId: event.turnId,
    role: 'assistant',
    content,
    createdAt: event.occurredAt,
  };
}

function eventQuestionSet(event: BusinessEvent): QuestionSet | null {
  if (event.type !== 'input.required' || !isRecord(event.payload.questionSet)) return null;
  return event.payload.questionSet as unknown as QuestionSet;
}

function eventTurnProblem(event: BusinessEvent): ProblemDetails | undefined {
  if (event.type !== 'turn.failed' && event.type !== 'turn.interrupted') return undefined;
  const raw = event.payload.problem;
  if (
    !isRecord(raw) ||
    typeof raw.type !== 'string' ||
    typeof raw.title !== 'string' ||
    typeof raw.status !== 'number' ||
    typeof raw.detail !== 'string' ||
    typeof raw.code !== 'string' ||
    typeof raw.correlationId !== 'string'
  ) {
    return undefined;
  }
  return raw as unknown as ProblemDetails;
}

function eventExecutionPlan(event: BusinessEvent): ExecutionPlanView | null {
  if (event.type !== 'execution.plan' || !isRecord(event.payload.executionPlan)) return null;
  const rawPlan = event.payload.executionPlan;
  if (typeof rawPlan.planId !== 'string' || !Array.isArray(rawPlan.nodes)) return null;
  const nodes = rawPlan.nodes.flatMap((rawNode) => {
    if (!isRecord(rawNode)) return [];
    if (
      typeof rawNode.id !== 'string' ||
      typeof rawNode.title !== 'string' ||
      typeof rawNode.skillName !== 'string' ||
      !Array.isArray(rawNode.dependsOn) ||
      rawNode.dependsOn.some((dependency) => typeof dependency !== 'string')
    ) {
      return [];
    }
    return [
      {
        id: rawNode.id,
        title: rawNode.title,
        skillName: rawNode.skillName,
        dependsOn: rawNode.dependsOn,
        ...(typeof rawNode.parallelGroup === 'string'
          ? { parallelGroup: rawNode.parallelGroup }
          : {}),
      },
    ];
  });
  if (nodes.length !== rawPlan.nodes.length) return null;
  return {
    planId: rawPlan.planId,
    ...(typeof rawPlan.title === 'string' ? { title: rawPlan.title } : {}),
    nodes,
  };
}

function eventActivities(event: BusinessEvent): ActivityItem[] {
  const supported = new Set<BusinessEvent['type']>([
    'turn.started',
    'turn.completed',
    'turn.partial',
    'plan.updated',
    'agent.activity',
    'skill.started',
    'skill.progress',
    'skill.completed',
    'artifact.created',
  ]);
  if (!supported.has(event.type) || !event.turnId) return [];
  if (Array.isArray(event.payload.activities)) {
    return event.payload.activities.filter(isRecord).map((raw, index) => ({
      id: typeof raw.id === 'string' ? raw.id : `event-${event.eventId}-${index}`,
      turnId: event.turnId as string,
      kind: 'plan',
      title: typeof raw.title === 'string' ? raw.title : '计划步骤',
      status: activityStatus(raw.status),
      startedAt: event.occurredAt,
    }));
  }
  const raw = isRecord(event.payload.activity) ? event.payload.activity : event.payload;
  const allowedKinds = new Set<ActivityItem['kind']>([
    'plan',
    'agent',
    'skill',
    'command',
    'reasoning_summary',
    'web_search',
    'artifact',
    'warning',
    'error',
  ]);
  const rawKind = typeof raw.kind === 'string' ? raw.kind : '';
  const kind = event.type.startsWith('skill.')
    ? 'skill'
    : event.type === 'plan.updated'
      ? 'plan'
      : allowedKinds.has(rawKind as ActivityItem['kind'])
        ? (rawKind as ActivityItem['kind'])
        : 'agent';
  const inferredStatus = event.type === 'skill.completed' ? 'completed' : 'running';
  const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
  const stage = typeof raw.stage === 'string' ? raw.stage : undefined;
  const progress = isRecord(raw.progress)
    ? (raw.progress as unknown as ActivityItem['progress'])
    : undefined;
  const parallelGroup = typeof raw.parallelGroup === 'string' ? raw.parallelGroup : undefined;
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  const reasoning =
    typeof raw.reasoning === 'string' ? (raw.reasoning as ReasoningLevel) : undefined;
  const tokens = isRecord(raw.tokens)
    ? (raw.tokens as unknown as ActivityItem['tokens'])
    : undefined;
  const skillName = typeof raw.skillName === 'string' ? raw.skillName : undefined;
  const jobId = typeof raw.jobId === 'string' ? raw.jobId : undefined;
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((item): item is string => typeof item === 'string')
    : undefined;
  const outcome =
    raw.outcome === 'succeeded' || raw.outcome === 'partial' ? raw.outcome : undefined;
  const resultRefs = activityResultRefs(raw.resultRefs);
  return [
    {
      id: typeof raw.id === 'string' ? raw.id : `event-${event.eventId}`,
      turnId: event.turnId,
      kind,
      title: typeof raw.title === 'string' ? raw.title : event.type,
      ...(summary ? { summary } : {}),
      status: activityStatus(raw.status ?? inferredStatus),
      ...(stage ? { stage } : {}),
      ...(progress ? { progress } : {}),
      ...(parallelGroup ? { parallelGroup } : {}),
      ...(model ? { model } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(tokens ? { tokens } : {}),
      ...(skillName ? { skillName } : {}),
      ...(jobId ? { jobId } : {}),
      ...(warnings ? { warnings } : {}),
      ...(outcome ? { outcome } : {}),
      ...(resultRefs ? { resultRefs } : {}),
      startedAt: event.occurredAt,
    },
  ];
}

function mergeSkillJobs(current: SkillJobView[], incoming: SkillJobView[]): SkillJobView[] {
  const terminalStatuses = new Set<SkillJobStatus>([
    'succeeded',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
  ]);
  const statusOrder: Record<SkillJobStatus, number> = {
    queued: 0,
    needs_input: 1,
    running: 2,
    cancelling: 3,
    succeeded: 4,
    partial: 4,
    failed: 4,
    cancelled: 4,
    interrupted: 4,
  };
  const merged = incoming.map((job) => {
    const existing = current.find((candidate) => candidate.jobId === job.jobId);
    const resultRefs = [...(existing?.resultRefs ?? []), ...(job.resultRefs ?? [])].filter(
      (ref, index, refs) =>
        refs.findIndex((candidate) => candidate.artifactId === ref.artifactId) === index,
    );
    const resumed = existing?.status === 'needs_input' && job.status === 'queued';
    const status =
      existing &&
      !resumed &&
      (terminalStatuses.has(existing.status) || statusOrder[existing.status] > statusOrder[job.status])
        ? existing.status
        : job.status;
    return existing
      ? {
          ...job,
          status,
          ...(existing.stage && !job.stage ? { stage: existing.stage } : {}),
          ...(existing.progress && !job.progress ? { progress: existing.progress } : {}),
          warnings: [...new Set([...existing.warnings, ...job.warnings])],
          ...(resultRefs.length ? { resultRefs } : {}),
        }
      : { ...job, ...(resultRefs.length ? { resultRefs } : {}) };
  });
  const incomingIds = new Set(incoming.map((job) => job.jobId));
  return [...merged, ...current.filter((job) => !incomingIds.has(job.jobId))];
}

function skillJobStatusFromActivity(activity: ActivityItem): SkillJobStatus | null {
  if (activity.kind !== 'skill' || !activity.jobId) return null;
  if (activity.status === 'completed')
    return activity.outcome === 'partial' ? 'partial' : 'succeeded';
  if (activity.status === 'partial') return 'partial';
  if (
    activity.status === 'queued' ||
    activity.status === 'running' ||
    activity.status === 'needs_input' ||
    activity.status === 'cancelling' ||
    activity.status === 'cancelled' ||
    activity.status === 'failed' ||
    activity.status === 'interrupted'
  ) {
    return activity.status;
  }
  return null;
}

function updateSkillJobs(
  jobs: SkillJobView[],
  turnId: string,
  activities: ActivityItem[],
): SkillJobView[] {
  return activities.reduce((current, activity) => {
    const status = skillJobStatusFromActivity(activity);
    if (!status || !activity.jobId) return current;
    const existing = current.find((job) => job.jobId === activity.jobId);
    const next: SkillJobView = {
      turnId,
      skillName: activity.skillName ?? existing?.skillName ?? activity.title,
      jobId: activity.jobId,
      status,
      ...(activity.stage
        ? { stage: activity.stage }
        : existing?.stage
          ? { stage: existing.stage }
          : {}),
      ...(activity.progress
        ? { progress: activity.progress }
        : existing?.progress
          ? { progress: existing.progress }
          : {}),
      warnings: [...new Set([...(existing?.warnings ?? []), ...(activity.warnings ?? [])])],
      ...(activity.resultRefs?.length || existing?.resultRefs?.length
        ? {
            resultRefs: [...(existing?.resultRefs ?? []), ...(activity.resultRefs ?? [])].filter(
              (ref, index, refs) =>
                refs.findIndex((candidate) => candidate.artifactId === ref.artifactId) === index,
            ),
          }
        : {}),
    };
    return existing
      ? current.map((job) => (job.jobId === activity.jobId ? next : job))
      : [...current, next];
  }, jobs);
}

function replaceById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, position) => (position === index ? item : candidate));
}

function updateSessionCollections(
  state: WorkspaceState,
  session: SessionSummary,
): Pick<WorkspaceState, 'sessions' | 'archivedSessions'> {
  const withoutSession = (items: SessionSummary[]) =>
    items.filter((candidate) => candidate.id !== session.id);
  const upsertSession = (items: SessionSummary[]) =>
    items.some((candidate) => candidate.id === session.id)
      ? replaceById(items, session)
      : [session, ...items];
  if (session.archived) {
    return {
      sessions: withoutSession(state.sessions),
      archivedSessions: upsertSession(state.archivedSessions),
    };
  }
  return {
    sessions: upsertSession(state.sessions),
    archivedSessions: withoutSession(state.archivedSessions),
  };
}

function upsertActivity(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const existing = items.find((candidate) => candidate.id === item.id);
  if (!existing) return [...items, item];
  return items.map((candidate) =>
    candidate.id === item.id
      ? {
          ...candidate,
          ...item,
          ...(candidate.startedAt ? { startedAt: candidate.startedAt } : {}),
        }
      : candidate,
  );
}

export function reduceWorkspace(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'BOOT_START':
      return { ...state, loading: true, notice: null };
    case 'BOOT_READY': {
      const defaultModel =
        action.models.find((model) => model.isDefault && model.available) ??
        action.models.find((model) => model.available);
      return {
        ...state,
        loading: false,
        models: action.models,
        sessions: action.sessions,
        archivedSessions: action.archivedSessions,
        selectedModel: defaultModel?.id ?? '',
        selectedReasoning: defaultModel?.reasoningLevels.includes('xhigh')
          ? 'xhigh'
          : (defaultModel?.reasoningLevels[0] ?? 'xhigh'),
      };
    }
    case 'BUSY':
      return { ...state, busy: action.value };
    case 'CURRENT': {
      const sameSession = state.current?.id === action.session.id;
      const turns = action.session.turns.map((turn) => {
        const existing = sameSession
          ? state.current?.turns.find((candidate) => candidate.id === turn.id)
          : undefined;
        return existing
          ? {
              ...turn,
              activities: existing.activities,
              ...(turn.executionPlan || !existing.executionPlan
                ? {}
                : { executionPlan: existing.executionPlan }),
            }
          : turn;
      });
      const current: SessionDetail = {
        ...action.session,
        turns,
        lastEventId: sameSession
          ? Math.max(action.session.lastEventId, state.current?.lastEventId ?? 0)
          : action.session.lastEventId,
        skillJobs: sameSession
          ? mergeSkillJobs(state.current?.skillJobs ?? [], action.session.skillJobs)
          : action.session.skillJobs,
      };
      return {
        ...state,
        current,
        ...updateSessionCollections(state, current),
        selectedModel: action.session.model ?? state.selectedModel,
        selectedReasoning: action.session.reasoning ?? state.selectedReasoning,
        sessionDrawerOpen: false,
        notice: null,
      };
    }
    case 'SESSION_UPDATED': {
      const current =
        state.current?.id === action.session.id
          ? { ...state.current, ...action.session }
          : state.current;
      return {
        ...state,
        current,
        ...updateSessionCollections(state, action.session),
        selectedModel: action.session.model ?? state.selectedModel,
        selectedReasoning: action.session.reasoning ?? state.selectedReasoning,
      };
    }
    case 'REMOVE_CURRENT':
      return {
        ...state,
        current: state.current?.id === action.sessionId ? null : state.current,
        sessions: state.sessions.filter((session) => session.id !== action.sessionId),
        archivedSessions: state.archivedSessions.filter(
          (session) => session.id !== action.sessionId,
        ),
      };
    case 'SELECT_MODEL':
      if (state.current?.modelLocked) return state;
      return { ...state, selectedModel: action.model, selectedReasoning: action.reasoning };
    case 'CONNECTION':
      return { ...state, connected: action.connected };
    case 'NOTICE':
      return { ...state, notice: action.notice };
    case 'SESSION_DRAWER':
      return { ...state, sessionDrawerOpen: action.open };
    case 'ACTIVITY':
      return { ...state, activityOpen: action.open };
    case 'EVENT': {
      if (!state.current || state.current.id !== action.event.sessionId) return state;
      if (action.event.eventId <= state.current.lastEventId) return state;
      const sessionStatus = statusForEvent(action.event.type) as SessionStatus | null;
      const message = eventMessage(action.event);
      const candidateQuestionSet = eventQuestionSet(action.event);
      const executionPlan = eventExecutionPlan(action.event);
      const turnProblem = eventTurnProblem(action.event);
      const activities = eventActivities(action.event);
      const knownTurn = state.current.turns.some((turn) => turn.id === action.event.turnId);
      const turnsBeforeEvent =
        action.event.turnId && !knownTurn
          ? [
              ...state.current.turns,
              {
                id: action.event.turnId,
                status: statusForEvent(action.event.type) ?? ('running' as const),
                startedAt: action.event.occurredAt,
                messages: [],
                activities: [],
                results: [],
                ...(turnProblem ? { problem: turnProblem } : {}),
                ...(executionPlan ? { executionPlan } : {}),
              },
            ]
          : state.current.turns;
      const eventTurn = turnsBeforeEvent.find((turn) => turn.id === action.event.turnId);
      const latestTurn = turnsBeforeEvent.at(-1);
      const isLatestTurn = !latestTurn || latestTurn.id === action.event.turnId;
      const questionSet =
        candidateQuestionSet && isLatestTurn && (!eventTurn || !isTerminalStatus(eventTurn.status))
          ? candidateQuestionSet
          : null;
      const terminalActivity = terminalActivityStatus(action.event.type);
      const turns = turnsBeforeEvent.map((turn) => {
        if (turn.id !== action.event.turnId) return turn;
        return {
          ...turn,
          status: isTerminalStatus(turn.status)
            ? turn.status
            : (statusForEvent(action.event.type) ?? turn.status),
          messages: message ? replaceById(turn.messages, message) : turn.messages,
          ...(turnProblem ? { problem: turnProblem } : {}),
          ...(executionPlan ? { executionPlan } : {}),
          ...(questionSet || turn.questionSet
            ? { questionSet: questionSet ?? turn.questionSet }
            : {}),
          activities: activities.reduce(upsertActivity, turn.activities).map((activity) => {
            if (
              action.event.type === 'input.required' &&
              activity.kind === 'skill' &&
              (activity.status === 'running' ||
                activity.status === 'queued' ||
                activity.status === 'cancelling')
            ) {
              return { ...activity, status: 'needs_input' as const };
            }
            return terminalActivity &&
              (activity.status === 'running' || activity.status === 'pending')
              ? { ...activity, status: terminalActivity }
              : activity;
          }),
        };
      });
      const skillJobs = action.event.turnId
        ? updateSkillJobs(
            state.current.skillJobs,
            action.event.turnId,
            turns.find((turn) => turn.id === action.event.turnId)?.activities ?? [],
          ).map((job) =>
            action.event.type === 'input.required' &&
            job.turnId === action.event.turnId &&
            (job.status === 'running' || job.status === 'queued' || job.status === 'cancelling')
              ? { ...job, status: 'needs_input' as const }
              : job,
          )
        : state.current.skillJobs;
      const activeQuestionSet =
        isLatestTurn && sessionStatus && isTerminalStatus(sessionStatus)
          ? undefined
          : (questionSet ?? state.current.activeQuestionSet);
      const { activeQuestionSet: _previousQuestionSet, ...currentWithoutQuestionSet } =
        state.current;
      const current: SessionDetail = {
        ...currentWithoutQuestionSet,
        lastEventId: action.event.eventId,
        skillJobs,
        status:
          isLatestTurn && !isTerminalStatus(state.current.status) && sessionStatus
            ? sessionStatus
            : state.current.status,
        turns,
        ...(activeQuestionSet ? { activeQuestionSet } : {}),
      };
      return {
        ...state,
        current,
        ...updateSessionCollections(state, current),
      };
    }
  }
}

function noticeFrom(error: unknown): Notice {
  if (error instanceof ApiProblem) {
    return {
      title: error.problem.title,
      detail: error.problem.detail,
      ...(error.problem.recovery ? { recovery: error.problem.recovery } : {}),
      correlationId: error.problem.correlationId,
    };
  }
  return {
    title: '无法完成操作',
    detail: error instanceof Error ? error.message : '发生未知错误，请检查服务状态。',
    recovery: '运行 ./scripts/doctor 查看服务和依赖状态。',
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message)))
  );
}

function sessionTitleFromMessage(content: string): string | undefined {
  const firstLine = content.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, ' ');
  if (!firstLine) return undefined;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function useWorkspace(clientOverride?: ApiClient) {
  const client = useMemo(() => clientOverride ?? createApiClient(), [clientOverride]);
  const [state, dispatch] = useReducer(reduceWorkspace, initialState);
  const refreshTimer = useRef<number | null>(null);

  const refreshCurrent = useCallback(
    async (sessionId: string) => {
      try {
        dispatch({ type: 'CURRENT', session: await client.getSession(sessionId) });
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      }
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: 'BOOT_START' });
    Promise.all([
      client.listModels(controller.signal),
      client.listSessions({ archived: false }, controller.signal),
      client.listSessions({ archived: true }, controller.signal),
    ])
      .then(async ([models, sessions, archivedSessions]) => {
        dispatch({ type: 'BOOT_READY', models, sessions, archivedSessions });
        const latest = sessions[0];
        if (latest) dispatch({ type: 'CURRENT', session: await client.getSession(latest.id) });
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      });
    return () => controller.abort();
  }, [client]);

  useEffect(() => {
    if (!state.current) return undefined;
    const sessionId = state.current.id;
    const subscription = client.subscribe(sessionId, state.current.lastEventId, {
      onConnection: (connected) => dispatch({ type: 'CONNECTION', connected }),
      onError: (error) => dispatch({ type: 'NOTICE', notice: noticeFrom(error) }),
      onEvent: (event) => {
        dispatch({ type: 'EVENT', event });
        if (
          event.type === 'input.required' ||
          event.type === 'artifact.created' ||
          event.type.startsWith('turn.')
        ) {
          if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => void refreshCurrent(sessionId), 120);
        }
      },
    });
    return () => {
      subscription.close();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [client, refreshCurrent, state.current?.id]);

  const selectSession = useCallback(
    async (sessionId: string) => {
      dispatch({ type: 'BUSY', value: true });
      try {
        dispatch({ type: 'CURRENT', session: await client.getSession(sessionId) });
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      } finally {
        dispatch({ type: 'BUSY', value: false });
      }
    },
    [client],
  );

  const createSession = useCallback(async () => {
    if (!state.selectedModel) return;
    dispatch({ type: 'BUSY', value: true });
    try {
      const session = await client.createSession({
        model: state.selectedModel,
        reasoning: state.selectedReasoning,
        idempotencyKey: idempotencyKey('session'),
      });
      dispatch({ type: 'CURRENT', session });
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
    } finally {
      dispatch({ type: 'BUSY', value: false });
    }
  }, [client, state.selectedModel, state.selectedReasoning]);

  const searchSessions = useCallback(
    async (query: string) => {
      try {
        const [sessions, archivedSessions] = await Promise.all([
          client.listSessions({ search: query, archived: false }),
          client.listSessions({ search: query, archived: true }),
        ]);
        dispatch({ type: 'BOOT_READY', models: state.models, sessions, archivedSessions });
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      }
    },
    [client, state.models],
  );

  const send = useCallback(
    async (content: string, files: File[], reuseAvailableData = false) => {
      let session = state.current;
      dispatch({ type: 'BUSY', value: true });
      try {
        if (!session) {
          session = await client.createSession({
            model: state.selectedModel,
            reasoning: state.selectedReasoning,
            idempotencyKey: idempotencyKey('session'),
          });
          dispatch({ type: 'CURRENT', session });
        }
        const autoTitle =
          session.title === '新会话' ? sessionTitleFromMessage(content) : undefined;
        const uploads = files.length
          ? await client.upload(session.id, files, idempotencyKey('upload'))
          : [];
        const sourceRefs =
          uploads.length > 0
            ? uploads.map((upload) => upload.sourceRef)
            : reuseAvailableData
              ? session.uploads.map((upload) => upload.sourceRef)
              : [];
        await client.sendMessage(session.id, {
          content,
          sourceRefs,
          idempotencyKey: idempotencyKey('turn'),
        });
        if (autoTitle) {
          try {
            const updated = await client.updateSession(session.id, { title: autoTitle });
            dispatch({ type: 'SESSION_UPDATED', session: updated });
          } catch (error) {
            dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
          }
        }
        await refreshCurrent(session.id);
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      } finally {
        dispatch({ type: 'BUSY', value: false });
      }
    },
    [client, refreshCurrent, state.current, state.selectedModel, state.selectedReasoning],
  );

  const answerQuestions = useCallback(
    async (questionSet: QuestionSet, answers: Record<string, string>) => {
      if (!state.current) return;
      dispatch({ type: 'BUSY', value: true });
      try {
        await client.sendMessage(state.current.id, {
          content: '已提交问题组回答。',
          sourceRefs: [],
          answers,
          questionSetId: questionSet.id,
          idempotencyKey: idempotencyKey('answers'),
        });
        await refreshCurrent(state.current.id);
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      } finally {
        dispatch({ type: 'BUSY', value: false });
      }
    },
    [client, refreshCurrent, state.current],
  );

  const saveQuestionDraft = useCallback(
    async (questionSetId: string, draft: Record<string, string>) => {
      if (!state.current) return;
      try {
        await client.saveQuestionDraft(state.current.id, questionSetId, draft);
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
        throw error;
      }
    },
    [client, state.current],
  );

  const cancel = useCallback(async () => {
    if (!state.current) return;
    dispatch({ type: 'BUSY', value: true });
    try {
      await client.cancel(state.current.id, idempotencyKey('cancel'));
      await refreshCurrent(state.current.id);
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
    } finally {
      dispatch({ type: 'BUSY', value: false });
    }
  }, [client, refreshCurrent, state.current]);

  const rerun = useCallback(
    async (turnId: string) => {
      if (
        !state.current ||
        state.current.turns.some((turn) => turn.id === turnId && !isTerminalStatus(turn.status))
      ) {
        return;
      }
      const turn = state.current.turns.find((candidate) => candidate.id === turnId);
      const message = turn?.messages.findLast((candidate) => candidate.role === 'user');
      if (!turn || !message) return;
      dispatch({ type: 'BUSY', value: true });
      try {
        await client.sendMessage(state.current.id, {
          content: message.content,
          sourceRefs: message.sourceRefs ?? [],
          idempotencyKey: idempotencyKey('rerun'),
        });
        await refreshCurrent(state.current.id);
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      } finally {
        dispatch({ type: 'BUSY', value: false });
      }
    },
    [client, refreshCurrent, state.current],
  );

  const deleteCurrent = useCallback(async () => {
    if (!state.current) return;
    const id = state.current.id;
    dispatch({ type: 'BUSY', value: true });
    try {
      await client.deleteSession(id, idempotencyKey('delete'));
      dispatch({ type: 'REMOVE_CURRENT', sessionId: id });
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
    } finally {
      dispatch({ type: 'BUSY', value: false });
    }
  }, [client, state.current]);

  const updateCurrentSession = useCallback(
    async (input: { title?: string; archived?: boolean }) => {
      if (!state.current) return;
      dispatch({ type: 'BUSY', value: true });
      try {
        const session = await client.updateSession(state.current.id, input);
        dispatch({ type: 'SESSION_UPDATED', session });
      } catch (error) {
        dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
      } finally {
        dispatch({ type: 'BUSY', value: false });
      }
    },
    [client, state.current],
  );

  const renameCurrent = useCallback(
    async (title: string) => updateCurrentSession({ title }),
    [updateCurrentSession],
  );
  const archiveCurrent = useCallback(
    async () => updateCurrentSession({ archived: true }),
    [updateCurrentSession],
  );
  const restoreCurrent = useCallback(
    async () => updateCurrentSession({ archived: false }),
    [updateCurrentSession],
  );

  const selectModel = useCallback(
    (model: string, reasoning: ReasoningLevel) => {
      const current = state.current;
      if (current?.modelLocked) return;
      const previous =
        current?.model && current.reasoning
          ? { model: current.model, reasoning: current.reasoning }
          : undefined;
      dispatch({ type: 'SELECT_MODEL', model, reasoning });
      if (!current) return;
      dispatch({ type: 'BUSY', value: true });
      void client
        .updateSession(current.id, { model, reasoning })
        .then((session) => dispatch({ type: 'SESSION_UPDATED', session }))
        .catch((error: unknown) => {
          if (previous) dispatch({ type: 'SELECT_MODEL', ...previous });
          dispatch({ type: 'NOTICE', notice: noticeFrom(error) });
        })
        .finally(() => dispatch({ type: 'BUSY', value: false }));
    },
    [client, state.current],
  );
  const dismissNotice = useCallback(() => dispatch({ type: 'NOTICE', notice: null }), []);
  const setSessionDrawer = useCallback(
    (open: boolean) => dispatch({ type: 'SESSION_DRAWER', open }),
    [],
  );
  const setActivityOpen = useCallback((open: boolean) => dispatch({ type: 'ACTIVITY', open }), []);

  const actions = useMemo(
    () => ({
      selectSession,
      createSession,
      searchSessions,
      send,
      answerQuestions,
      saveQuestionDraft,
      cancel,
      deleteCurrent,
      renameCurrent,
      archiveCurrent,
      restoreCurrent,
      rerun,
      selectModel,
      dismissNotice,
      setSessionDrawer,
      setActivityOpen,
    }),
    [
      answerQuestions,
      cancel,
      createSession,
      deleteCurrent,
      renameCurrent,
      archiveCurrent,
      restoreCurrent,
      rerun,
      dismissNotice,
      saveQuestionDraft,
      searchSessions,
      selectModel,
      selectSession,
      send,
      setActivityOpen,
      setSessionDrawer,
    ],
  );

  return {
    state,
    actions,
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspace>;
