import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

import { MAX_UPLOAD_FILE_BYTES } from '@building-energy/contracts';

import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  AGENT_TURN_OUTPUT_SCHEMA,
  CodexAdapterError,
  buildTurnPrompt,
  classifySdkError,
  diagnoseCodexSandbox,
  FakeCodexAdapter,
  parseAgentTurnOutput,
} from '../src/codex-adapter.js';
import { loadModelCatalog } from '../src/config.js';
import { problem, Repository, RepositoryError } from '../src/database.js';
import { doctorChecks } from '../src/diagnostics.js';
import { buildDiagnosticExport } from '../src/diagnostic-export.js';
import { CodexEventProjector } from '../src/event-projector.js';
import {
  isBlockedAddress,
  PublicReadError,
  PublicReadGateway,
} from '../src/public-read-gateway.js';
import { createRotatingJsonlLogger, createSafeLogger, redactText } from '../src/redaction.js';
import { SessionRuntime } from '../src/runtime.js';
import type { CodexAdapter, ServerConfig } from '../src/types.js';
import { UploadService } from '../src/uploads.js';
import { sessionSocketPath, WorkspaceBoundaryError, WorkspaceManager } from '../src/workspace.js';
import { ArtifactService } from '../src/artifacts.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'be-server-'));
  const modelsPath = path.join(root, 'models.yaml');
  await writeFile(
    modelsPath,
    'version: 1\ndefault:\n  model: test-model\n  reasoning: low\nmodels:\n  - id: test-model\n    display_name: Test\n    reasoning_levels: [low]\n',
  );
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 8787,
    projectRoot: root,
    runtimeRoot: path.join(root, '.runtime'),
    databasePath: path.join(root, '.runtime/app.db'),
    modelsPath,
    serviceVersion: 'test',
    codexProbeModels: false,
    cancelTimeoutMs: 1_000,
    heartbeatMs: 20,
    slowConsumerTimeoutMs: 100,
    logs: { maxBytes: 16_384, backups: 2 },
    publicRead: {
      timeoutMs: 100,
      maxBytes: 1024,
      maxRedirects: 2,
      allowedMediaTypes: ['text/', 'application/json'],
    },
  };
  const repository = new Repository(config.databasePath);
  const workspaces = new WorkspaceManager(config.runtimeRoot);
  await workspaces.initialize();
  repository.migrate();
  const models = await loadModelCatalog(modelsPath);
  return { root, config, repository, workspaces, models };
}

describe('repository and workspace invariants', () => {
  it('enables WAL/foreign keys and admits only one active turn', async () => {
    const { repository, workspaces } = await fixture();
    expect(repository.pragmas()).toEqual({ journalMode: 'wal', foreignKeys: true });
    const paths = await workspaces.createSession('session-1');
    repository.createSession({
      id: 'session-1',
      title: 'test',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        repository.createTurn({
          sessionId: 'session-1',
          idempotencyKey: 'one',
          content: 'a',
          sourceRefs: [],
        }),
      ),
      Promise.resolve().then(() =>
        repository.createTurn({
          sessionId: 'session-1',
          idempotencyKey: 'two',
          content: 'b',
          sourceRefs: [],
        }),
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: 'SESSION_BUSY' });
    repository.close();
  });

  it('adds archive state to existing V1 sessions without losing their rows', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'be-session-migration-'));
    const repository = new Repository(path.join(root, 'app.db'));
    repository.db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2026-08-10T00:00:00.000Z');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        thread_id TEXT UNIQUE,
        model TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace TEXT NOT NULL UNIQUE,
        model_locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    repository.db
      .prepare(
        `INSERT INTO sessions
         (id, title, thread_id, model, reasoning, status, workspace, model_locked, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-v1',
        '已有会话',
        null,
        'test-model',
        'low',
        'idle',
        path.join(root, 'workspace'),
        0,
        '2026-08-10T00:00:00.000Z',
        '2026-08-10T00:00:00.000Z',
      );

    repository.migrate();

    expect(repository.requireSession('session-v1')).toMatchObject({
      title: '已有会话',
      archived: false,
    });
    expect(
      repository.db
        .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
        .get(),
    ).toMatchObject({ version: 2 });
    repository.close();
  });

  it('replays idempotent turns and rejects key reuse with different content', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('session-2');
    repository.createSession({
      id: 'session-2',
      title: 'test',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const first = repository.createTurn({
      sessionId: 'session-2',
      idempotencyKey: 'same',
      content: 'a',
      sourceRefs: [],
    });
    const replay = repository.createTurn({
      sessionId: 'session-2',
      idempotencyKey: 'same',
      content: 'a',
      sourceRefs: [],
    });
    expect(replay).toMatchObject({ replayed: true, turn: { id: first.turn.id } });
    expect(() =>
      repository.createTurn({
        sessionId: 'session-2',
        idempotencyKey: 'same',
        content: 'different',
        sourceRefs: [],
      }),
    ).toThrow(RepositoryError);
    repository.close();
  });

  it('allocates monotonic session-local event cursors and preserves terminal status', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('session-3');
    repository.createSession({
      id: 'session-3',
      title: 'test',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const turn = repository.createTurn({
      sessionId: 'session-3',
      idempotencyKey: 'turn',
      content: 'a',
      sourceRefs: [],
    }).turn;
    const first = repository.startTurn(turn.id).event;
    const second = repository.appendEvent({
      protocol_version: '1.0',
      session_id: 'session-3',
      turn_id: turn.id,
      type: 'agent.activity',
      data: {
        activity_id: 'activity-1',
        kind: 'info',
        status: 'completed',
        summary: 'ok',
      },
    });
    expect([first.event_id, second.event_id]).toEqual(['1', '2']);
    repository.failTurn(turn.id, problem('TURN_FAILED', 500, 'failed', 'failed', randomUUID()));
    expect(() =>
      repository.db.prepare("UPDATE turns SET status='running' WHERE id=?").run(turn.id),
    ).toThrow();
    repository.close();
  });

  it('reconciles open activities before publishing a terminal turn', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('session-activity-terminal');
    repository.createSession({
      id: 'session-activity-terminal',
      title: 'test',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const turn = repository.createTurn({
      sessionId: 'session-activity-terminal',
      idempotencyKey: 'turn',
      content: 'a',
      sourceRefs: [],
    }).turn;
    repository.startTurn(turn.id);
    repository.appendEvent({
      protocol_version: '1.0',
      session_id: 'session-activity-terminal',
      turn_id: turn.id,
      type: 'agent.activity',
      data: {
        activity_id: 'command-open',
        kind: 'command',
        status: 'in_progress',
        summary: 'running command',
      },
    });

    const terminal = repository.finishTurn({
      turnId: turn.id,
      status: 'completed',
      message: 'done',
      resultRefs: [],
      durationMs: 10,
    });

    expect(terminal.map((event) => event.type)).toEqual([
      'agent.activity',
      'assistant.message',
      'turn.completed',
    ]);
    const activity = repository
      .eventsAfter('session-activity-terminal')
      .filter((event) => event.type === 'agent.activity')
      .at(-1);
    expect(activity?.data).toMatchObject({
      activity_id: 'command-open',
      status: 'completed',
      summary: 'running command',
    });
    repository.close();
  });

  it('rejects traversal and symlink escapes', async () => {
    const { root, workspaces } = await fixture();
    await workspaces.createSession('session-path');
    expect(() => workspaces.resolveWorkspaceWrite('session-path', '../outside')).toThrow(
      WorkspaceBoundaryError,
    );
    const link = workspaces.resolveWorkspaceWrite('session-path', 'link');
    await symlink(root, link);
    await expect(
      workspaces.assertWritableTarget(
        workspaces.paths('session-path').workspace,
        path.join(link, 'escape.txt'),
      ),
    ).rejects.toThrow(WorkspaceBoundaryError);
  });

  it('uses a short deterministic socket path even below a long DGX project path', async () => {
    const runtimeRoot = path.join(
      tmpdir(),
      'building-energy-codex-acceptance-with-a-deliberately-long-runtime-segment',
    );
    const manager = new WorkspaceManager(runtimeRoot);
    const first = manager.paths('11111111-1111-4111-8111-111111111111').socket;
    const second = manager.paths('22222222-2222-4222-8222-222222222222').socket;
    expect(Buffer.byteLength(first)).toBeLessThan(108);
    expect(first).toBe(sessionSocketPath(runtimeRoot, '11111111-1111-4111-8111-111111111111'));
    expect(first).toBe(manager.paths('11111111-1111-4111-8111-111111111111').socket);
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(manager.socketsRoot);
  });
});

describe('runtime recovery, cancellation, and generic projection', () => {
  it('uses a structured-output-compatible schema and normalizes both envelope variants', () => {
    expect(AGENT_TURN_OUTPUT_SCHEMA).not.toHaveProperty('oneOf');
    expect(
      parseAgentTurnOutput({
        status: 'completed',
        message: 'done',
        result_refs: [],
        questions: [],
      }),
    ).toEqual({ status: 'completed', message: 'done', result_refs: [] });
    expect(
      parseAgentTurnOutput({
        status: 'needs_input',
        message: 'choose',
        result_refs: [],
        questions: [
          {
            id: 'timezone',
            question: 'Timezone?',
            options: ['Asia/Shanghai'],
            allow_free_text: false,
            required: true,
          },
        ],
      }),
    ).toMatchObject({ status: 'needs_input', questions: [{ id: 'timezone' }] });
  });

  it('tells Codex to declare plans with exact project Skill IDs', () => {
    const prompt = buildTurnPrompt({
      sessionId: 'session-1',
      turnId: 'turn-1',
      threadId: null,
      workspacePath: '/tmp/workspace',
      model: 'test-model',
      reasoningLevel: 'low',
      content: '解析上传数据',
      sources: [],
      signal: new AbortController().signal,
      onThreadStarted: async () => undefined,
      onEvent: async () => undefined,
    });

    expect(prompt).toContain('`building-energy-data-parsing`');
    expect(prompt).toContain('`building-energy-load-forecasting`');
    expect(prompt).toContain('not a Chinese display label');
  });

  it('classifies an account usage limit as an unavailable model dependency', () => {
    expect(classifySdkError('You have hit your usage limit; purchase more credits.')).toMatchObject(
      { code: 'MODEL_UNAVAILABLE' },
    );
  });

  it('publishes input.required immediately when a Skill needs structured input', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const adapter = new FakeCodexAdapter();
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const common = {
      protocol_version: '1.0',
      skill_name: 'building-energy-data-parsing',
      job_id: 'job-needs-timezone',
      timestamp: new Date().toISOString(),
      warnings: [],
      payload: {},
    };
    const executionPlan = {
      plan_id: 'plan-needs-timezone',
      title: '解析上传数据',
      nodes: [
        {
          id: 'parse',
          title: '解析上传数据',
          skill_name: 'building-energy-data-parsing',
          depends_on: [],
        },
      ],
    };
    const skillEvents = [
      { ...common, event_id: 'skill-started', kind: 'started', stage: 'parsing' },
      {
        ...common,
        event_id: 'skill-needs-input',
        kind: 'needs_input',
        stage: 'awaiting_input',
        questions: [
          {
            id: 'source_timezone',
            question: '源数据使用哪个时区？',
            options: ['Asia/Shanghai'],
            allow_free_text: true,
            required: true,
          },
        ],
      },
    ];
    adapter.enqueue({
      threadId: 'skill-needs-input-thread',
      events: [
        {
          type: 'item.completed',
          item: {
            id: 'skill-needs-input-command',
            type: 'command_execution',
            command: 'skill-run start',
            aggregated_output: `BE_EXECUTION_PLAN ${JSON.stringify(executionPlan)}\n${skillEvents.map((event) => `BE_SKILL_EVENT ${JSON.stringify(event)}`).join('\n')}\n`,
            exit_code: 0,
            status: 'completed',
          },
        },
      ],
      envelope: { status: 'completed', message: 'should not complete', result_refs: [] },
    });

    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'needs-timezone',
      content: '解析上传数据',
    });
    await runtime.waitForIdle(session.id);

    expect(repository.requireTurn(submitted.turn.id).status).toBe('needs_input');
    expect(repository.requireSession(session.id).status).toBe('needs_input');
    expect(repository.pendingQuestionSet(session.id)).toMatchObject({
      turn_id: submitted.turn.id,
      questions: [{ id: 'source_timezone', question: '源数据使用哪个时区？' }],
    });
    expect(repository.skillJobsForTurn(submitted.turn.id)).toMatchObject([
      { status: 'needs_input', metadata: { questions: [{ id: 'source_timezone' }] } },
    ]);
    const eventTypes = repository.eventsAfter(session.id).map((event) => event.type);
    expect(eventTypes).toContain('input.required');
    expect(eventTypes).not.toContain('turn.cancelled');
    expect(eventTypes).not.toContain('turn.failed');
    repository.close();
  });

  it('continues a question answer on the original planned Turn', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const adapter = new FakeCodexAdapter();
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const sourcePath = workspaces.resolveInput(session.id, 'source.xlsx');
    await writeFile(sourcePath, 'source');
    repository.registerUploads([
      {
        id: 'source-upload',
        sessionId: session.id,
        sourceRef: 'source-resume',
        originalName: 'source.xlsx',
        relativePath: 'source.xlsx',
        size: 6,
        sha256: createHash('sha256').update('source').digest('hex'),
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        createdAt: new Date().toISOString(),
      },
    ]);
    const plan = {
      plan_id: 'plan-resume',
      title: '解析并预测',
      nodes: [
        {
          id: 'parse',
          title: '解析数据',
          skill_name: 'building-energy-data-parsing',
          depends_on: [],
        },
      ],
    };
    const needsInputEvent = {
      protocol_version: '1.0',
      event_id: 'needs-input-timezone',
      skill_name: 'building-energy-data-parsing',
      job_id: 'job-resume',
      kind: 'needs_input',
      stage: 'awaiting_input',
      timestamp: new Date().toISOString(),
      warnings: [],
      payload: {},
      questions: [
        {
          id: 'timezone',
          question: '源数据使用哪个时区？',
          options: ['Asia/Shanghai'],
          allow_free_text: false,
          required: true,
        },
      ],
    };
    const startedEvent = {
      protocol_version: '1.0',
      event_id: 'started-input-timezone',
      skill_name: 'building-energy-data-parsing',
      job_id: 'job-resume',
      kind: 'started',
      stage: 'parsing',
      timestamp: new Date().toISOString(),
      warnings: [],
      payload: {},
    };
    adapter.enqueue({
      threadId: 'resume-thread',
      events: [
        {
          type: 'item.completed',
          item: {
            id: 'initial-command',
            type: 'command_execution',
            command: 'skill-run start',
            aggregated_output: `BE_EXECUTION_PLAN ${JSON.stringify(plan)}\nBE_SKILL_EVENT ${JSON.stringify(startedEvent)}\nBE_SKILL_EVENT ${JSON.stringify(needsInputEvent)}\n`,
            exit_code: 0,
            status: 'completed',
          },
        },
      ],
      envelope: { status: 'completed', message: 'not used', result_refs: [] },
    });
    adapter.enqueue({
      threadId: 'resume-thread',
      envelope: { status: 'completed', message: '已继续原任务。', result_refs: [] },
    });

    const initial = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'initial-resume',
      content: '解析上传数据',
      sourceRefs: ['source-resume'],
    });
    await runtime.waitForIdle(session.id);
    expect(repository.requireTurn(initial.turn.id).status).toBe('needs_input');
    const questionSet = repository.pendingQuestionSet(session.id)!;
    const resumed = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'answer-resume',
      questionSetId: String(questionSet.question_set_id),
      answers: [{ question_id: 'timezone', answer: 'Asia/Shanghai' }],
    });
    await runtime.waitForIdle(session.id);

    expect(resumed.turn.id).toBe(initial.turn.id);
    expect(repository.turns(session.id)).toHaveLength(1);
    expect(repository.requireTurn(initial.turn.id)).toMatchObject({
      status: 'completed',
      executionPlan: plan,
    });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.turnId).toBe(initial.turn.id);
    expect(adapter.requests[1]?.runtimeContext).toContain('"execution_plan"');
    repository.close();
  });

  it('marks an unprovable active turn interrupted during restart', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const paths = await workspaces.createSession('restart-session');
    repository.createSession({
      id: 'restart-session',
      title: 'restart',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const turn = repository.createTurn({
      sessionId: 'restart-session',
      idempotencyKey: 'start',
      content: 'run',
      sourceRefs: [],
    }).turn;
    repository.startTurn(turn.id);
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      new FakeCodexAdapter(),
      models,
      config,
    );
    await runtime.initialize();
    expect(repository.requireTurn(turn.id).status).toBe('interrupted');
    expect(repository.eventsAfter('restart-session').at(-1)?.type).toBe('turn.interrupted');
    repository.close();
  });

  it('propagates AbortSignal and publishes cancelled only after fake execution stops', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const adapter = new FakeCodexAdapter();
    adapter.enqueue({
      delayMs: 500,
      envelope: { status: 'completed', message: 'should not complete', result_refs: [] },
    });
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'turn',
      content: 'run',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    repository.upsertSkillJob({
      id: 'skill-job-row',
      sessionId: session.id,
      turnId: submitted.turn.id,
      skillName: 'building-energy-data-parsing',
      externalJobId: 'job-cancel-proof',
      status: 'running',
      metadata: {},
    });
    await runtime.cancel(session.id, 'cancel', 'stop');
    const replay = await runtime.cancel(session.id, 'cancel', 'stop');
    expect(replay).toMatchObject({ replayed: true, turn: { status: 'cancelled' } });
    expect(repository.requireTurn(submitted.turn.id).status).toBe('cancelled');
    expect(
      repository
        .eventsAfter(session.id)
        .filter((event) => event.type.startsWith('turn.'))
        .at(-1)?.type,
    ).toBe('turn.cancelled');
    expect(repository.skillJobsForTurn(submitted.turn.id)).toMatchObject([
      { externalJobId: 'job-cancel-proof', status: 'cancelled' },
    ]);
    expect(repository.eventsAfter(session.id)).toContainEqual(
      expect.objectContaining({
        type: 'agent.activity',
        data: expect.objectContaining({
          activity_id: 'skill:job-cancel-proof',
          status: 'completed',
        }),
      }),
    );
    repository.close();
  });

  it('projects any conforming skill name without a backend branch and redacts secrets', () => {
    const projector = new CodexEventProjector('session', 'turn');
    const skillLine = `BE_SKILL_EVENT ${JSON.stringify({
      protocol_version: '1.0',
      event_id: '1',
      skill_name: 'future-carbon-intensity',
      job_id: 'job-1',
      kind: 'progress',
      stage: 'fetch',
      timestamp: new Date().toISOString(),
      warnings: [],
      progress: { completed: 1, total: 2, unit: 'stage' },
      payload: {},
    })}\n`;
    const projected = projector.project({
      type: 'item.updated',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: 'tool --token sk_abcdefghijklmnop /home/person/private',
        aggregated_output: skillLine,
        status: 'in_progress',
      },
    });
    expect(projected.skillEvents[0]).toMatchObject({
      skill_name: 'future-carbon-intensity',
      kind: 'progress',
    });
    expect(JSON.stringify(projected.events)).not.toContain('sk_abcdefghijklmnop');
    expect(JSON.stringify(projected.events)).not.toContain('/home/person/private');
    expect(redactText('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('requires an execution plan before the first started Skill event', () => {
    const projector = new CodexEventProjector('session', 'turn');
    const startedLine = `BE_SKILL_EVENT ${JSON.stringify({
      protocol_version: '1.0',
      event_id: '1',
      skill_name: 'future-carbon-intensity',
      job_id: 'job-1',
      kind: 'started',
      stage: 'start',
      timestamp: new Date().toISOString(),
      warnings: [],
      payload: {},
    })}\n`;
    expect(() =>
      projector.project({
        type: 'item.updated',
        item: {
          id: 'command-without-plan',
          type: 'command_execution',
          command: 'skillctl start',
          aggregated_output: startedLine,
          status: 'in_progress',
        },
      }),
    ).toThrow('首个 skill.started 前缺少 execution.plan');
  });

  it('discovers a newly installed instruction-only Skill by directory contract', async () => {
    const { root, config, repository, workspaces, models } = await fixture();
    const skillRoot = path.join(root, '.agents/skills/future-grid-emissions');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: future-grid-emissions\ndescription: Test dynamic discovery\n---\n',
    );
    const checks = await doctorChecks({
      config,
      repository,
      workspaces,
      adapter: new FakeCodexAdapter(),
      models: models.models,
    });
    expect(checks).toContainEqual(
      expect.objectContaining({
        name: 'skill:future-grid-emissions',
        status: 'ready',
        capability_summary: expect.stringContaining('instruction-only'),
      }),
    );
    repository.close();
  });

  it('reports restricted Linux userns as unavailable without an AppArmor profile', async () => {
    await expect(
      diagnoseCodexSandbox({
        platform: 'linux',
        profile: '',
        readRestriction: async () => '1\n',
      }),
    ).resolves.toMatchObject({
      name: 'codex-sandbox',
      status: 'unavailable',
      recovery_command: expect.stringContaining('BE_CODEX_APPARMOR_PROFILE'),
    });
  });

  it('requires the configured AppArmor profile to pass a real namespace canary', async () => {
    let probed = '';
    await expect(
      diagnoseCodexSandbox({
        platform: 'linux',
        profile: 'linux-sandbox',
        readRestriction: async () => '1',
        probeProfile: async (profile) => {
          probed = profile;
        },
      }),
    ).resolves.toMatchObject({ name: 'codex-sandbox', status: 'ready' });
    expect(probed).toBe('linux-sandbox');
  });

  it('keeps a terminal Skill job stable while a later result command registers its artifact', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const executionPlan = {
      plan_id: 'plan-sequence',
      title: '动态技能执行',
      nodes: [
        {
          id: 'node-sequence',
          title: '执行动态技能',
          skill_name: 'future-grid-emissions',
          depends_on: [],
        },
      ],
    };
    const adapter: CodexAdapter = {
      async runTurn(request) {
        await request.onThreadStarted('skill-sequence-thread');
        const artifactDirectory = path.join(request.workspacePath, 'artifacts', 'sequence');
        await mkdir(artifactDirectory, { recursive: true });
        const content = Buffer.from('verified sequence\n');
        const sha256 = createHash('sha256').update(content).digest('hex');
        await writeFile(path.join(artifactDirectory, 'result.txt'), content);
        const artifactRef = {
          artifact_id: 'artifact-sequence',
          artifact_type: 'sequence-report',
          status: 'succeeded' as const,
          manifest_url: `/api/v1/sessions/${request.sessionId}/artifacts?turn_id=${request.turnId}`,
        };
        await writeFile(
          path.join(artifactDirectory, 'manifest.json'),
          JSON.stringify({
            schema_version: '1.0',
            artifact_id: artifactRef.artifact_id,
            artifact_type: artifactRef.artifact_type,
            producer: { skill_name: 'future-grid-emissions', job_id: 'job-sequence' },
            source_ids: [],
            status: 'succeeded',
            files: [
              {
                relative_path: 'sequence/result.txt',
                media_type: 'text/plain',
                size_bytes: content.length,
                sha256,
                role: 'report',
              },
            ],
            summary: { conclusion: 'verified' },
            warnings: [],
          }),
        );
        const common = {
          protocol_version: '1.0',
          skill_name: 'future-grid-emissions',
          job_id: 'job-sequence',
          timestamp: new Date().toISOString(),
          warnings: [],
          payload: {},
        };
        const events = [
          { ...common, event_id: '1', kind: 'started', stage: 'start' },
          {
            ...common,
            event_id: '2',
            kind: 'progress',
            stage: 'compute',
            progress: { completed: 1, total: 1, unit: 'stage' },
          },
          {
            ...common,
            event_id: '3',
            kind: 'completed',
            stage: 'completed',
            outcome: 'succeeded',
            result_refs: [artifactRef],
          },
          {
            ...common,
            event_id: '4',
            kind: 'artifact',
            stage: 'artifacts',
            artifact_id: artifactRef.artifact_id,
            manifest_relative_path: 'sequence/manifest.json',
          },
          {
            ...common,
            event_id: '3',
            kind: 'completed',
            stage: 'completed',
            outcome: 'succeeded',
            result_refs: [artifactRef],
          },
        ];
        await request.onEvent({
          type: 'item.completed',
          item: {
            id: 'skill-result-command',
            type: 'command_execution',
            command: 'skillctl result job-sequence',
            aggregated_output: `BE_EXECUTION_PLAN ${JSON.stringify(executionPlan)}\n${events.map((event) => `BE_SKILL_EVENT ${JSON.stringify(event)}`).join('\n')}\n`,
            exit_code: 0,
            status: 'completed',
          },
        });
        return {
          threadId: 'skill-sequence-thread',
          envelope: {
            status: 'completed',
            message: 'sequence complete',
            result_refs: [artifactRef],
          },
        };
      },
      async diagnose() {
        return [];
      },
    };
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'skill-sequence-turn',
      content: 'run the dynamic skill',
    });
    await runtime.waitForIdle(session.id);

    expect(repository.requireTurn(submitted.turn.id)).toMatchObject({
      status: 'completed',
      executionPlan,
    });
    const persistedTypes = repository
      .eventsAfter(session.id)
      .filter((event) => event.turn_id === submitted.turn.id)
      .map((event) => event.type);
    expect(persistedTypes.indexOf('execution.plan')).toBeGreaterThanOrEqual(0);
    expect(persistedTypes.indexOf('execution.plan')).toBeLessThan(
      persistedTypes.indexOf('skill.started'),
    );
    expect(repository.skillJobsForTurn(submitted.turn.id)).toMatchObject([
      {
        externalJobId: 'job-sequence',
        status: 'succeeded',
        metadata: {
          stage: 'completed',
          progress: { completed: 1, total: 1, unit: 'stage' },
          warnings: [],
          result_refs: [expect.objectContaining({ artifact_id: 'artifact-sequence' })],
        },
      },
    ]);
    expect(repository.artifacts(session.id)).toHaveLength(1);
    expect(repository.eventsAfter(session.id).map((event) => event.type)).toEqual(
      expect.arrayContaining(['skill.completed', 'artifact.created', 'turn.completed']),
    );
    repository.close();
  });
});

describe('runtime progress safeguards', () => {
  it('keeps ordinary natural-language answers free of execution plans', async () => {
    const { config, repository, workspaces, models } = await fixture();
    const adapter = new FakeCodexAdapter();
    adapter.enqueue({
      envelope: { status: 'completed', message: '普通问答完成', result_refs: [] },
    });
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'ordinary-question',
      content: '请用一句话解释什么是峰值负荷。',
    });
    await runtime.waitForIdle(session.id);
    expect(repository.requireTurn(submitted.turn.id).status).toBe('completed');
    expect(adapter.requests[0]?.runtimeContext).toContain('verified_artifacts');
    expect(adapter.requests[0]?.runtimeContext).toContain('allowed_next_steps');
    expect(repository.eventsAfter(session.id).map((event) => event.type)).not.toContain(
      'execution.plan',
    );
    repository.close();
  });

  it('exposes a verified Artifact ref while the Codex summary is still delayed', async () => {
    const { config, repository, workspaces, models } = await fixture();
    config.watchdogIntervalMs = 5;
    config.watchdogWarningMs = 500;
    config.watchdogTerminationMs = 1_000;
    let artifactCreated: (() => void) | undefined;
    const artifactReady = new Promise<void>((resolve) => {
      artifactCreated = resolve;
    });
    const adapter: CodexAdapter = {
      async runTurn(request) {
        await request.onThreadStarted('early-artifact-thread');
        const directory = path.join(request.workspacePath, 'artifacts', 'early');
        await mkdir(directory, { recursive: true });
        const content = Buffer.from('verified before summary\n');
        const sha256 = createHash('sha256').update(content).digest('hex');
        await writeFile(path.join(directory, 'result.txt'), content);
        const ref = {
          artifact_id: 'artifact-early',
          artifact_type: 'early-report',
          status: 'succeeded' as const,
          manifest_url: `/api/v1/sessions/${request.sessionId}/artifacts?turn_id=${request.turnId}`,
        };
        await writeFile(
          path.join(directory, 'manifest.json'),
          JSON.stringify({
            schema_version: '1.0',
            artifact_id: ref.artifact_id,
            artifact_type: ref.artifact_type,
            producer: { skill_name: 'future-grid-emissions', job_id: 'job-early' },
            source_ids: [],
            status: 'succeeded',
            files: [
              {
                relative_path: 'early/result.txt',
                media_type: 'text/plain',
                size_bytes: content.length,
                sha256,
                role: 'report',
              },
            ],
            summary: { conclusion: 'verified' },
            warnings: [],
          }),
        );
        const common = {
          protocol_version: '1.0',
          skill_name: 'future-grid-emissions',
          job_id: 'job-early',
          timestamp: new Date().toISOString(),
          warnings: [],
          payload: {},
        };
        const plan = {
          plan_id: 'plan-early',
          title: '早期 Artifact',
          nodes: [
            {
              id: 'early',
              title: '执行动态技能',
              skill_name: 'future-grid-emissions',
              depends_on: [],
            },
          ],
        };
        const events = [
          { ...common, event_id: 'early-started', kind: 'started', stage: 'start' },
          {
            ...common,
            event_id: 'early-completed',
            kind: 'completed',
            stage: 'completed',
            outcome: 'succeeded',
            result_refs: [ref],
          },
          {
            ...common,
            event_id: 'early-artifact',
            kind: 'artifact',
            stage: 'artifacts',
            artifact_id: ref.artifact_id,
            manifest_relative_path: 'early/manifest.json',
          },
        ];
        await request.onEvent({
          type: 'item.completed',
          item: {
            id: 'early-command',
            type: 'command_execution',
            command: 'skill-run result job-early',
            aggregated_output: `BE_EXECUTION_PLAN ${JSON.stringify(plan)}\n${events.map((event) => `BE_SKILL_EVENT ${JSON.stringify(event)}`).join('\n')}\n`,
            exit_code: 0,
            status: 'completed',
          },
        });
        artifactCreated?.();
        await new Promise((resolve) => setTimeout(resolve, 80));
        return {
          threadId: 'early-artifact-thread',
          envelope: { status: 'completed', message: 'done', result_refs: [] },
        };
      },
      async diagnose() {
        return [];
      },
    };
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'early-artifact',
      content: '请运行动态专业分析。',
    });
    await artifactReady;
    expect(repository.artifacts(session.id)).toHaveLength(1);
    expect(repository.requireTurn(submitted.turn.id)).toMatchObject({
      status: 'running',
      resultRefs: [expect.objectContaining({ artifact_id: 'artifact-early' })],
    });
    await runtime.waitForIdle(session.id);
    expect(repository.requireTurn(submitted.turn.id).status).toBe('completed');
    repository.close();
  });

  it('interrupts a live adapter after no observable Codex, Job, or Artifact progress', async () => {
    const { config, repository, workspaces, models } = await fixture();
    config.watchdogIntervalMs = 5;
    config.watchdogWarningMs = 10;
    config.watchdogTerminationMs = 30;
    let aborted = false;
    const adapter: CodexAdapter = {
      async runTurn(request) {
        await request.onThreadStarted('stalled-thread');
        await new Promise<never>((_, reject) => {
          request.signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new CodexAdapterError('ABORTED', 'adapter stopped'));
            },
            { once: true },
          );
        });
        throw new Error('unreachable');
      },
      async diagnose() {
        return [];
      },
    };
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'stalled-turn',
      content: '请执行一个无进展的任务。',
    });
    await runtime.waitForIdle(session.id);
    expect(aborted).toBe(true);
    expect(repository.requireTurn(submitted.turn.id).status).toBe('interrupted');
    expect(repository.eventsAfter(session.id).map((event) => event.type)).toContain('turn.interrupted');
    expect(repository.eventsAfter(session.id)).toContainEqual(
      expect.objectContaining({
        type: 'agent.activity',
        data: expect.objectContaining({ kind: 'warning' }),
      }),
    );
    repository.close();
  });

  it('does not interrupt a Skill that keeps reporting progress', async () => {
    const { config, repository, workspaces, models } = await fixture();
    config.watchdogIntervalMs = 5;
    config.watchdogWarningMs = 20;
    config.watchdogTerminationMs = 80;
    const adapter: CodexAdapter = {
      async runTurn(request) {
        await request.onThreadStarted('progress-thread');
        const plan = {
          plan_id: 'plan-progress',
          nodes: [
            {
              id: 'progress',
              title: '持续进展',
              skill_name: 'future-grid-emissions',
              depends_on: [],
            },
          ],
        };
        const common = {
          protocol_version: '1.0',
          skill_name: 'future-grid-emissions',
          job_id: 'job-progress',
          timestamp: new Date().toISOString(),
          warnings: [],
          payload: {},
        };
        const lines = [
          `BE_EXECUTION_PLAN ${JSON.stringify(plan)}`,
          `BE_SKILL_EVENT ${JSON.stringify({ ...common, event_id: 'started', kind: 'started', stage: 'start' })}`,
        ];
        for (let index = 1; index <= 5; index += 1) {
          lines.push(
            `BE_SKILL_EVENT ${JSON.stringify({ ...common, event_id: `progress-${index}`, kind: 'progress', stage: `stage-${index}`, progress: { completed: index, total: 5, unit: 'stage' } })}`,
          );
          await request.onEvent({
            type: 'item.updated',
            item: {
              id: 'progress-command',
              type: 'command_execution',
              command: 'skill-run status job-progress',
              aggregated_output: `${lines.join('\n')}\n`,
              status: 'in_progress',
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return {
          threadId: 'progress-thread',
          envelope: { status: 'completed', message: 'done', result_refs: [] },
        };
      },
      async diagnose() {
        return [];
      },
    };
    const runtime = new SessionRuntime(
      repository,
      workspaces,
      new ArtifactService(repository, workspaces),
      adapter,
      models,
      config,
    );
    await runtime.initialize();
    await runtime.createSession({ model: 'test-model', reasoning: 'low' });
    const session = repository.listSessions()[0]!;
    const submitted = runtime.submit({
      sessionId: session.id,
      idempotencyKey: 'progress-turn',
      content: '请持续报告进度。',
    });
    await runtime.waitForIdle(session.id);
    expect(repository.requireTurn(submitted.turn.id).status).toBe('completed');
    expect(repository.skillJobsForTurn(submitted.turn.id)).toMatchObject([
      { externalJobId: 'job-progress', status: 'running' },
    ]);
    repository.close();
  });
});

describe('immutable upload and public read boundaries', () => {
  it('accepts a streamed CSV exactly at the 200 MB file and batch boundary', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('upload-boundary-session');
    repository.createSession({
      id: 'upload-boundary-session',
      title: 'upload boundary',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const header = Buffer.from('timestamp,point_id,value_raw\n');
    async function* exactBoundary() {
      yield header;
      let remaining = MAX_UPLOAD_FILE_BYTES - header.length;
      while (remaining > 0) {
        const size = Math.min(1024 * 1024, remaining);
        yield Buffer.alloc(size, 0x78);
        remaining -= size;
      }
    }
    try {
      const service = new UploadService(repository, workspaces);
      const rows = await service.ingest(
        'upload-boundary-session',
        (async function* () {
          yield { filename: 'boundary.csv', mimetype: 'text/csv', file: exactBoundary() };
        })(),
      );
      expect(rows).toMatchObject([{ size: MAX_UPLOAD_FILE_BYTES, mediaType: 'text/csv' }]);
    } finally {
      repository.deleteSession('upload-boundary-session');
      await workspaces.deleteSession('upload-boundary-session');
      repository.close();
    }
  }, 30_000);

  it('rolls back every upload row when an atomic batch registration fails', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('upload-atomic-session');
    repository.createSession({
      id: 'upload-atomic-session',
      title: 'upload atomicity',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const base = {
      sessionId: 'upload-atomic-session',
      sourceRef: 'src:duplicate',
      originalName: 'input.csv',
      size: 1,
      sha256: 'a'.repeat(64),
      mediaType: 'text/csv',
      createdAt: new Date().toISOString(),
    };
    expect(() =>
      repository.registerUploads(
        [
          { ...base, id: 'upload-row-1', relativePath: 'batch/one.csv' },
          { ...base, id: 'upload-row-2', relativePath: 'batch/two.csv' },
        ],
        { scope: 'upload:upload-atomic-session', key: 'atomic', requestHash: 'request' },
      ),
    ).toThrow();
    expect(repository.uploads('upload-atomic-session')).toEqual([]);
    expect(
      repository.getIdempotency('upload:upload-atomic-session', 'atomic', 'request'),
    ).toBeNull();
    repository.close();
  });

  it('removes a whole upload batch when a stream is interrupted', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('upload-session');
    repository.createSession({
      id: 'upload-session',
      title: 'upload',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const service = new UploadService(repository, workspaces);
    async function* brokenFiles() {
      yield {
        filename: 'data.csv',
        mimetype: 'text/csv',
        file: (async function* () {
          yield Buffer.from('timestamp,point_id,value_raw\n');
          throw new Error('connection lost');
        })(),
      };
    }
    await expect(service.ingest('upload-session', brokenFiles())).rejects.toThrow(
      'connection lost',
    );
    expect(
      Number(
        (repository.db.prepare('SELECT COUNT(*) AS count FROM uploads').get() as { count: number })
          .count,
      ),
    ).toBe(0);
    expect((await import('node:fs/promises')).readdir(paths.inputs)).resolves.toEqual([]);
    repository.close();
  });

  it('blocks loopback, private, link-local, documentation, and credentialed URLs', async () => {
    expect(
      ['127.0.0.1', '10.1.2.3', '169.254.1.1', '::1', 'fc00::1', '2001:db8::1'].every(
        isBlockedAddress,
      ),
    ).toBe(true);
    const { config, repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('gateway-session');
    repository.createSession({
      id: 'gateway-session',
      title: 'gateway',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const logger = createSafeLogger(() => undefined);
    const gateway = new PublicReadGateway(
      'gateway-session',
      workspaces,
      config.publicRead,
      logger,
      () => undefined,
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    await expect(
      gateway.fetch({ url: 'https://example.com/data', method: 'GET', output: 'public/data.txt' }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    await expect(
      gateway.fetch({ url: 'https://user:pass@example.com', method: 'HEAD' }),
    ).rejects.toBeInstanceOf(PublicReadError);
    repository.close();
  });

  it('revalidates redirects and enforces response media and size before writing', async () => {
    const { config, repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('gateway-policy');
    repository.createSession({
      id: 'gateway-policy',
      title: 'gateway',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const logger = createSafeLogger(() => undefined);
    const redirecting = new PublicReadGateway(
      'gateway-policy',
      workspaces,
      config.publicRead,
      logger,
      () => undefined,
      async (hostname) => [
        hostname === 'blocked.example'
          ? { address: '10.0.0.5', family: 4 as const }
          : { address: '8.8.8.8', family: 4 as const },
      ],
      async () => response(302, { location: 'https://blocked.example/private' }),
    );
    await expect(
      redirecting.fetch({ url: 'https://public.example/start', method: 'HEAD' }),
    ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });

    const wrongType = new PublicReadGateway(
      'gateway-policy',
      workspaces,
      config.publicRead,
      logger,
      () => undefined,
      async () => [{ address: '8.8.8.8', family: 4 }],
      async () => response(200, { 'content-type': 'application/octet-stream' }, ['data']),
    );
    await expect(
      wrongType.fetch({
        url: 'https://public.example/data',
        method: 'GET',
        output: 'public/data.bin',
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });

    const tooLarge = new PublicReadGateway(
      'gateway-policy',
      workspaces,
      config.publicRead,
      logger,
      () => undefined,
      async () => [{ address: '8.8.8.8', family: 4 }],
      async () =>
        response(200, { 'content-type': 'text/plain', 'content-length': '2048' }, ['data']),
    );
    await expect(
      tooLarge.fetch({
        url: 'https://public.example/data',
        method: 'GET',
        output: 'public/data.txt',
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });

    const allowed = new PublicReadGateway(
      'gateway-policy',
      workspaces,
      config.publicRead,
      logger,
      () => undefined,
      async () => [{ address: '8.8.8.8', family: 4 }],
      async () => response(200, { 'content-type': 'text/plain' }, ['public data']),
    );
    const result = await allowed.fetch({
      url: 'https://public.example/data?private=query',
      method: 'GET',
      output: 'public/data.txt',
    });
    expect(result).toMatchObject({ status: 200, size_bytes: 11, output: 'public/data.txt' });
    expect(await readFile(path.join(paths.workspace, 'public/data.txt'), 'utf8')).toBe(
      'public data',
    );
    expect(result.source_url).not.toContain('private=query');
    repository.close();
  });

  it('rejects chunked bodies and unknown credential headers at the Unix socket boundary', async () => {
    const { config, repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('gateway-local-policy');
    repository.createSession({
      id: 'gateway-local-policy',
      title: 'gateway local policy',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    let upstreamCalls = 0;
    const gateway = new PublicReadGateway(
      'gateway-local-policy',
      workspaces,
      config.publicRead,
      createSafeLogger(() => undefined),
      () => undefined,
      async () => [{ address: '8.8.8.8', family: 4 }],
      async () => {
        upstreamCalls += 1;
        return response(200, { 'content-type': 'text/plain' }, ['not reached']);
      },
    );
    const socketPath = await gateway.start();
    const target = '/fetch?url=https%3A%2F%2Fpublic.example%2Fdata&method=HEAD';
    const chunked = await unixRequest(
      socketPath,
      target,
      { 'transfer-encoding': 'chunked' },
      'local upload data',
    );
    expect(chunked.status).toBe(405);
    expect(chunked.body).toContain('METHOD_NOT_ALLOWED');
    const credential = await unixRequest(socketPath, target, { 'x-api-key': 'unknown-secret' });
    expect(credential.status).toBe(405);
    expect(upstreamCalls).toBe(0);
    await gateway.close();
    repository.close();
  });

  it('registers only hash-valid artifact files and rejects later tampering', async () => {
    const { repository, workspaces } = await fixture();
    const paths = await workspaces.createSession('artifact-session');
    repository.createSession({
      id: 'artifact-session',
      title: 'artifact',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const turn = repository.createTurn({
      sessionId: 'artifact-session',
      idempotencyKey: 'artifact-turn',
      content: 'make artifact',
      sourceRefs: [],
    }).turn;
    repository.startTurn(turn.id);
    const artifactDirectory = path.join(paths.artifacts, 'report');
    await mkdir(artifactDirectory, { recursive: true });
    const content = Buffer.from('verified result\n');
    const sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(path.join(artifactDirectory, 'result.txt'), content);
    await writeFile(
      path.join(artifactDirectory, 'manifest.json'),
      JSON.stringify({
        schema_version: '1.0',
        artifact_id: 'artifact-1',
        artifact_type: 'future-report',
        producer: { skill_name: 'future-grid-emissions', job_id: 'job-1' },
        source_ids: [],
        status: 'succeeded',
        files: [
          {
            relative_path: 'report/result.txt',
            media_type: 'text/plain',
            size_bytes: content.length,
            sha256,
            role: 'report',
          },
        ],
        summary: {
          conclusion: 'safe result',
          unsafe: 'Bearer abcdefghijklmnop /home/person/private/result.csv',
        },
        warnings: ['See /home/person/private/warning.txt'],
      }),
    );
    const service = new ArtifactService(repository, workspaces);
    const registered = await service.registerManifest(
      'artifact-session',
      turn.id,
      'report/manifest.json',
    );
    expect(registered.ref.manifest_url).toBe(
      `/api/v1/sessions/artifact-session/artifacts?turn_id=${turn.id}`,
    );
    expect((await service.download('artifact-1', 0)).sha256).toBe(sha256);
    const publicResource = service.resourceById('artifact-1');
    expect(JSON.stringify(publicResource)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(publicResource)).not.toContain('/home/person/private');
    await writeFile(path.join(artifactDirectory, 'result.txt'), 'tampered');
    await expect(service.download('artifact-1', 0)).rejects.toMatchObject({
      code: 'ARTIFACT_INTEGRITY_FAILED',
    });
    repository.close();
  });
});

function response(statusCode: number, headers: Record<string, string>, chunks: string[] = []) {
  const stream = Readable.from(chunks);
  return Object.assign(stream, { statusCode, headers });
}

async function unixRequest(
  socketPath: string,
  requestPath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: requestPath, method: 'GET', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.once('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

describe('privacy-preserving local logs', () => {
  it('exports aggregate diagnostics without IDs, secrets, or absolute paths', async () => {
    const { root, config, repository, workspaces, models } = await fixture();
    const paths = await workspaces.createSession('diagnostic-session');
    repository.createSession({
      id: 'diagnostic-session',
      title: 'private title',
      model: 'test-model',
      reasoning: 'low',
      workspace: paths.workspace,
    });
    const report = await buildDiagnosticExport({
      config,
      repository,
      workspaces,
      adapter: new FakeCodexAdapter(),
      models,
    });
    expect(report).toMatchObject({
      schema_version: '1.0',
      state_summary: { sessions: [{ status: 'empty', count: 1 }], turns: [] },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('diagnostic-session');
    expect(serialized).not.toContain('private title');
    expect(serialized).not.toContain(root);
    repository.close();
  });

  it('redacts credentialed proxy URLs and configured proxy values', () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy-user:proxy-pass@proxy.invalid:8080';
    try {
      const redacted = redactText(
        'HTTPS_PROXY=http://proxy-user:proxy-pass@proxy.invalid:8080 http://other:secret@example.com/path',
      );
      expect(redacted).not.toContain('proxy-pass');
      expect(redacted).not.toContain('other:secret');
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });

  it('writes timestamped JSONL, redacts secrets and absolute paths, and rotates at a size bound', async () => {
    const { root } = await fixture();
    const directory = path.join(root, '.runtime/logs');
    const logger = createRotatingJsonlLogger(directory, { maxBytes: 512, backups: 2 });
    for (let index = 0; index < 20; index += 1) {
      logger.info(
        {
          correlation_id: `correlation-${index}`,
          detail: 'Bearer abcdefghijklmnop /home/person/private/data.csv',
        },
        'diagnostic event',
      );
    }
    const files = await readdir(directory);
    expect(files.length).toBeLessThanOrEqual(3);
    const content = (
      await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')))
    ).join('\n');
    expect(content).not.toContain('abcdefghijklmnop');
    expect(content).not.toContain('/home/person/private');
    for (const line of content.split('\n').filter(Boolean)) {
      expect(JSON.parse(line)).toMatchObject({
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        correlation_id: expect.stringMatching(/^correlation-/),
      });
    }
  });
});
