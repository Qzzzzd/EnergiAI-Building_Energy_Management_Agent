import { describe, expect, it } from 'vitest';
import type { BusinessEvent, SessionDetail } from '../domain';
import { reduceWorkspace } from './workspace';

type WorkspaceState = Parameters<typeof reduceWorkspace>[0];

const now = '2026-08-10T01:00:00.000Z';

function session(status: SessionDetail['status'] = 'running'): SessionDetail {
  return {
    id: 'session-1',
    title: '冷站分析',
    status,
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    modelLocked: true,
    archived: false,
    updatedAt: now,
    preview: '分析冷站负荷',
    createdAt: now,
    lastEventId: 4,
    skillJobs: [],
    turns: [
      {
        id: 'turn-1',
        status: status === 'idle' || status === 'deleting' ? 'running' : status,
        startedAt: now,
        messages: [],
        activities: [],
        results: [],
      },
    ],
    uploads: [],
    artifacts: [],
    disclosure: '本地删除边界说明',
  };
}

function state(current = session()): WorkspaceState {
  return {
    models: [
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        reasoningLevels: ['high', 'xhigh'],
        available: true,
        isDefault: true,
      },
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        reasoningLevels: ['medium', 'high'],
        available: true,
      },
    ],
    sessions: [current],
    archivedSessions: [],
    current,
    selectedModel: 'gpt-5.6-sol',
    selectedReasoning: 'xhigh',
    loading: false,
    busy: false,
    connected: true,
    notice: null,
    sessionDrawerOpen: false,
    activityOpen: true,
  };
}

function event(
  eventId: number,
  type: BusinessEvent['type'],
  payload: Record<string, unknown> = {},
): BusinessEvent {
  return {
    protocolVersion: '1.0',
    eventId,
    sessionId: 'session-1',
    turnId: 'turn-1',
    type,
    occurredAt: now,
    payload,
  };
}

describe('reduceWorkspace SSE semantics', () => {
  it('stores the declared execution plan before merging later Skill activity into jobs', () => {
    const declared = reduceWorkspace(state(), {
      type: 'EVENT',
      event: event(5, 'execution.plan', {
        executionPlan: {
          planId: 'plan-1',
          title: '现场分析',
          nodes: [
            {
              id: 'node-parse',
              title: '解析数据',
              skillName: 'building-energy-data-parsing',
              dependsOn: [],
            },
            {
              id: 'node-quality',
              title: '评估质量',
              skillName: 'building-energy-data-quality',
              dependsOn: ['node-parse'],
              parallelGroup: 'result-analysis',
            },
          ],
        },
      }),
    });
    const running = reduceWorkspace(declared, {
      type: 'EVENT',
      event: event(6, 'skill.started', {
        activity: {
          id: 'skill:job-1',
          title: 'building-energy-data-parsing',
          skillName: 'building-energy-data-parsing',
          jobId: 'job-1',
          status: 'running',
        },
      }),
    });

    expect(running.current?.turns[0]?.executionPlan).toMatchObject({
      planId: 'plan-1',
      nodes: [{ id: 'node-parse' }, { id: 'node-quality', parallelGroup: 'result-analysis' }],
    });
    expect(running.current?.skillJobs).toMatchObject([
      { jobId: 'job-1', skillName: 'building-energy-data-parsing', status: 'running' },
    ]);
  });

  it('ignores duplicate and out-of-order event cursors without mutating state', () => {
    const original = state();

    expect(
      reduceWorkspace(original, {
        type: 'EVENT',
        event: event(4, 'assistant.message', { messageId: 'message-1', content: '重复消息' }),
      }),
    ).toBe(original);
    expect(
      reduceWorkspace(original, {
        type: 'EVENT',
        event: event(3, 'turn.completed'),
      }),
    ).toBe(original);
  });

  it('upserts repeated activity identities while advancing the cursor once', () => {
    const started = reduceWorkspace(state(), {
      type: 'EVENT',
      event: event(5, 'skill.started', {
        activity: { id: 'skill:job-1', title: '数据解析', status: 'running', stage: '读取' },
      }),
    });
    const progressed = reduceWorkspace(started, {
      type: 'EVENT',
      event: event(6, 'skill.progress', {
        activity: {
          id: 'skill:job-1',
          title: '数据解析',
          status: 'running',
          stage: '校验',
          progress: { completed: 2, total: 3, unit: 'stage' },
        },
      }),
    });

    expect(progressed.current?.lastEventId).toBe(6);
    expect(progressed.current?.turns[0]?.activities).toHaveLength(1);
    expect(progressed.current?.turns[0]?.activities[0]).toMatchObject({
      id: 'skill:job-1',
      stage: '校验',
      progress: { completed: 2, total: 3, unit: 'stage' },
    });
  });

  it('pauses active Skill jobs as needs_input when the turn requests structured input', () => {
    const started = reduceWorkspace(state(), {
      type: 'EVENT',
      event: event(5, 'skill.started', {
        activity: {
          id: 'skill:job-input',
          title: '数据解析',
          skillName: 'building-energy-data-parsing',
          jobId: 'job-input',
          status: 'running',
          stage: '等待点位确认',
        },
      }),
    });
    const waiting = reduceWorkspace(started, {
      type: 'EVENT',
      event: event(6, 'input.required', {
        questionSet: {
          id: 'questions-1',
          turnId: 'turn-1',
          status: 'pending',
          questions: [],
          draft: {},
        },
      }),
    });

    expect(waiting.current?.turns[0]?.activities[0]).toMatchObject({
      id: 'skill:job-input',
      status: 'needs_input',
    });
    expect(waiting.current?.skillJobs).toMatchObject([
      { jobId: 'job-input', status: 'needs_input' },
    ]);
  });

  it('closes stale activity items when a terminal turn event arrives', () => {
    const started = reduceWorkspace(state(), {
      type: 'EVENT',
      event: event(5, 'agent.activity', {
        activity: { id: 'command-1', title: '受控命令', kind: 'command', status: 'running' },
      }),
    });

    const completed = reduceWorkspace(started, {
      type: 'EVENT',
      event: event(6, 'turn.completed', {
        activity: { id: 'turn:turn-1', title: 'Codex Turn', status: 'completed' },
      }),
    });

    expect(completed.current?.turns[0]?.activities).toEqual([
      expect.objectContaining({ id: 'command-1', status: 'completed' }),
      expect.objectContaining({ id: 'turn:turn-1', status: 'completed' }),
    ]);
  });

  it('does not apply an event belonging to another session', () => {
    const original = state();
    const foreign = { ...event(5, 'turn.completed'), sessionId: 'session-2' };

    expect(reduceWorkspace(original, { type: 'EVENT', event: foreign })).toBe(original);
  });

  it('keeps the consumed cursor when a same-session snapshot refreshes at hydration cursor zero', () => {
    const live = state();
    const refreshed = session();
    refreshed.lastEventId = 0;

    const next = reduceWorkspace(live, { type: 'CURRENT', session: refreshed });

    expect(next.current?.lastEventId).toBe(4);
  });

  it('creates a minimal turn when live events arrive before the session snapshot', () => {
    const current = session('idle');
    current.lastEventId = 0;
    current.turns = [];
    let next = state(current);

    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: {
        ...event(1, 'turn.started', {
          activity: { id: 'turn:turn-fast', title: 'Codex Turn', status: 'running' },
        }),
        turnId: 'turn-fast',
      },
    });
    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: {
        ...event(2, 'turn.completed', {
          activity: {
            id: 'turn:turn-fast',
            title: 'Codex Turn',
            status: 'completed',
            tokens: { input: 120, cached: 80, output: 24 },
          },
        }),
        turnId: 'turn-fast',
      },
    });

    expect(next.current?.turns).toHaveLength(1);
    expect(next.current?.turns[0]).toMatchObject({
      id: 'turn-fast',
      status: 'completed',
      activities: [{ id: 'turn:turn-fast', tokens: { input: 120, cached: 80, output: 24 } }],
    });
  });

  it('keeps a cancelled turn terminal when a later success event arrives', () => {
    const cancelled = session('cancelled');
    const original = state(cancelled);

    const next = reduceWorkspace(original, {
      type: 'EVENT',
      event: event(5, 'turn.completed'),
    });

    expect(next.current?.status).toBe('cancelled');
    expect(next.current?.turns[0]?.status).toBe('cancelled');
  });

  it('rebuilds historical messages and activities without regressing a terminal snapshot', () => {
    const completed = session('completed');
    completed.lastEventId = 0;
    let next = state(completed);

    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: event(1, 'turn.started', {
        activity: {
          id: 'turn:turn-1',
          title: 'Codex Turn',
          status: 'running',
          model: 'gpt-5.6-sol',
          reasoning: 'xhigh',
        },
      }),
    });
    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: event(2, 'plan.updated', {
        activities: [{ id: 'plan-1', title: '读取输入', status: 'completed' }],
      }),
    });
    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: event(3, 'skill.completed', {
        activity: { id: 'skill:job-1', title: '数据解析', status: 'completed' },
      }),
    });
    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: event(4, 'assistant.message', {
        messageId: 'message-1',
        content: '已完成解析。',
      }),
    });
    next = reduceWorkspace(next, {
      type: 'EVENT',
      event: event(5, 'turn.completed', {
        activity: {
          id: 'turn:turn-1',
          title: 'Codex Turn',
          status: 'completed',
          tokens: { input: 1200, cached: 800, output: 240 },
        },
      }),
    });

    expect(next.current?.status).toBe('completed');
    expect(next.current?.turns[0]?.status).toBe('completed');
    expect(next.current?.turns[0]?.activities.map((item) => item.id)).toEqual([
      'turn:turn-1',
      'plan-1',
      'skill:job-1',
    ]);
    expect(next.current?.turns[0]?.messages).toMatchObject([
      { id: 'message-1', content: '已完成解析。' },
    ]);
    expect(next.current?.turns[0]?.activities[0]?.tokens).toEqual({
      input: 1200,
      cached: 800,
      output: 240,
    });
    expect(next.current?.turns[0]?.activities[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning: 'xhigh',
    });
    expect(next.current?.lastEventId).toBe(5);
  });

  it('does not restore an answered historical question group over a newer turn', () => {
    const current = session('running');
    current.lastEventId = 0;
    current.turns[0]!.status = 'needs_input';
    current.turns.push({
      id: 'turn-2',
      status: 'running',
      startedAt: now,
      messages: [],
      activities: [],
      results: [],
    });
    const historicalQuestion = {
      ...event(1, 'input.required', {
        questionSet: {
          id: 'question-set-1',
          turnId: 'turn-1',
          status: 'pending',
          questions: [],
          draft: {},
        },
      }),
      turnId: 'turn-1',
    };

    const next = reduceWorkspace(state(current), { type: 'EVENT', event: historicalQuestion });

    expect(next.current?.status).toBe('running');
    expect(next.current?.activeQuestionSet).toBeUndefined();
  });
});

describe('reduceWorkspace model selection', () => {
  it('ignores model changes after the conversation model is locked', () => {
    const original = state();
    const next = reduceWorkspace(original, {
      type: 'SELECT_MODEL',
      model: 'gpt-5.6-terra',
      reasoning: 'medium',
    });

    expect(next).toBe(original);
    expect(next.selectedModel).toBe('gpt-5.6-sol');
    expect(next.selectedReasoning).toBe('xhigh');
  });

  it('allows a selection before the first turn locks the model', () => {
    const unlocked = { ...session('idle'), modelLocked: false };
    const next = reduceWorkspace(state(unlocked), {
      type: 'SELECT_MODEL',
      model: 'gpt-5.6-terra',
      reasoning: 'medium',
    });

    expect(next.selectedModel).toBe('gpt-5.6-terra');
    expect(next.selectedReasoning).toBe('medium');
  });

  it('reflects the server-confirmed selection in workspace state', () => {
    const unlocked = { ...session('idle'), modelLocked: false };
    const next = reduceWorkspace(state(unlocked), {
      type: 'SESSION_UPDATED',
      session: {
        ...unlocked,
        model: 'gpt-5.6-terra',
        reasoning: 'medium',
      },
    });

    expect(next.selectedModel).toBe('gpt-5.6-terra');
    expect(next.selectedReasoning).toBe('medium');
  });
});

describe('reduceWorkspace archive state', () => {
  it('moves a current session between active and archived collections without losing its detail', () => {
    const archived = reduceWorkspace(state(), {
      type: 'SESSION_UPDATED',
      session: { ...session('completed'), title: '冷站历史分析', archived: true },
    });

    expect(archived.sessions).toEqual([]);
    expect(archived.archivedSessions).toMatchObject([
      { id: 'session-1', title: '冷站历史分析', archived: true },
    ]);
    expect(archived.current).toMatchObject({ id: 'session-1', archived: true });

    const restored = reduceWorkspace(archived, {
      type: 'SESSION_UPDATED',
      session: { ...session('completed'), title: '冷站历史分析', archived: false },
    });

    expect(restored.sessions).toMatchObject([{ id: 'session-1', archived: false }]);
    expect(restored.archivedSessions).toEqual([]);
    expect(restored.current?.archived).toBe(false);
  });
});
