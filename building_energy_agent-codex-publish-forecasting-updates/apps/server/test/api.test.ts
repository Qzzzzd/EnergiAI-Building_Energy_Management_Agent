import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApplication } from '../src/app.js';
import { FakeCodexAdapter } from '../src/codex-adapter.js';
import type { ServerConfig } from '../src/types.js';

async function application(existingConfig?: ServerConfig) {
  const root = existingConfig?.projectRoot ?? (await mkdtemp(path.join(tmpdir(), 'be-api-')));
  const modelsPath = existingConfig?.modelsPath ?? path.join(root, 'models.yaml');
  if (!existingConfig) {
    await writeFile(
      modelsPath,
      'version: 1\ndefault:\n  model: test-model\n  reasoning: low\nmodels:\n  - id: test-model\n    display_name: Test\n    reasoning_levels: [low, high]\n',
    );
  }
  const config: ServerConfig = existingConfig ?? {
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
  const adapter = new FakeCodexAdapter();
  return { ...(await createApplication({ config, adapter })), adapter };
}

describe('Fastify public API', () => {
  it('rolls back a newly persisted session when its local read gateway cannot start', async () => {
    const { app, gateways, repository } = await application();
    vi.spyOn(gateways, 'start').mockRejectedValueOnce(new Error('simulated gateway failure'));
    const request = {
      method: 'POST' as const,
      url: '/api/v1/sessions',
      headers: { 'idempotency-key': 'gateway-rollback' },
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(repository.listSessions()).toEqual([]);

    const retried = await app.inject(request);
    expect(retried.statusCode).toBe(201);
    expect(repository.listSessions()).toHaveLength(1);
    await app.close();
  });

  it('serves health/models, locks the selected model, and replays message idempotently', async () => {
    const { app, repository, runtime, adapter } = await application();
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ api_version: '1.0', status: 'ready' });
    const models = await app.inject({ method: 'GET', url: '/api/v1/models' });
    expect(models.json().models[0]).toMatchObject({ id: 'test-model', availability: 'available' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { 'idempotency-key': 'create-one' },
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().session.session_id as string;
    adapter.enqueue({
      envelope: { status: 'completed', message: 'done', result_refs: [] },
      events: [
        {
          type: 'item.completed',
          item: { id: 'reason-1', type: 'reasoning', text: 'checked inputs' },
        },
      ],
    });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'message-one' },
      payload: { api_version: '1.0', kind: 'message', content: 'analyze', source_refs: [] },
    });
    expect(first.statusCode).toBe(202);
    await runtime.waitForIdle(sessionId);
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'message-one' },
      payload: { api_version: '1.0', kind: 'message', content: 'analyze', source_refs: [] },
    });
    expect(replay.json()).toMatchObject({ replayed: true, turn: { status: 'completed' } });
    const persistedTurn = repository.turns(sessionId)[0]!;
    repository.upsertSkillJob({
      id: 'restored-skill-job',
      sessionId,
      turnId: persistedTurn.id,
      skillName: 'building-energy-load-forecasting',
      externalJobId: 'job-restored',
      status: 'partial',
      metadata: {
        stage: '生成预测结果',
        progress: { completed: 3, total: 4, unit: '阶段' },
        warnings: ['缺少一个可用点位。'],
        result_refs: [
          {
            artifact_id: 'artifact-restored',
            artifact_type: 'ForecastBundle',
            status: 'partial',
            manifest_url: '/api/v1/artifacts/artifact-restored',
          },
        ],
      },
    });
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` });
    expect(detail.json()).toMatchObject({
      session: { model: 'test-model', reasoning_level: 'low', model_locked: true },
      messages: [{ role: 'user' }, { role: 'assistant', content: 'done' }],
      skill_jobs: [
        {
          turn_id: persistedTurn.id,
          skill_name: 'building-energy-load-forecasting',
          job_id: 'job-restored',
          status: 'partial',
          stage: '生成预测结果',
          progress: { completed: 3, total: 4, unit: '阶段' },
          warnings: ['缺少一个可用点位。'],
          result_refs: [
            {
              artifact_id: 'artifact-restored',
              artifact_type: 'ForecastBundle',
              status: 'partial',
              manifest_url: '/api/v1/artifacts/artifact-restored',
            },
          ],
        },
      ],
    });
    const lockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'high' },
    });
    expect(lockedUpdate.statusCode).toBe(409);
    expect(lockedUpdate.json()).toMatchObject({ code: 'MODEL_LOCKED' });
    expect(repository.eventsAfter(sessionId).map((event) => event.type)).toEqual([
      'turn.started',
      'agent.activity',
      'assistant.message',
      'turn.completed',
    ]);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const firstReplay = await readSse(
      `${address}/api/v1/sessions/${sessionId}/events?after_event_id=2`,
    );
    expect(firstReplay).toContain('id: 3');
    expect(firstReplay).not.toContain('id: 2');
    const resumedReplay = await readSse(
      `${address}/api/v1/sessions/${sessionId}/events?after_event_id=3`,
    );
    expect(resumedReplay).toContain('id: 4');
    expect(resumedReplay).not.toContain('id: 3');
    await app.close();
  });

  it('renames, archives, and restores an inactive session through the public API', async () => {
    const { app } = await application();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;

    const modelChanged = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'high' },
    });
    expect(modelChanged.statusCode).toBe(200);
    expect(modelChanged.json()).toMatchObject({
      session: { model: 'test-model', reasoning_level: 'high', model_locked: false },
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', title: '  冷站历史分析  ' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      session: { session_id: sessionId, title: '冷站历史分析', archived: false },
    });

    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', archived: true },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().session.archived).toBe(true);
    const blockedMessage = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'archived-message' },
      payload: { api_version: '1.0', kind: 'message', content: '继续分析', source_refs: [] },
    });
    expect(blockedMessage.json()).toMatchObject({ code: 'SESSION_STATE_INVALID', status: 409 });
    expect((await app.inject({ method: 'GET', url: '/api/v1/sessions' })).json().sessions).toEqual(
      [],
    );
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/sessions?archived=true' })).json().sessions,
    ).toMatchObject([{ session_id: sessionId, archived: true }]);

    const restored = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', archived: false },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().session.archived).toBe(false);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/sessions?archived=false' })).json().sessions,
    ).toMatchObject([{ session_id: sessionId, archived: false }]);
    await app.close();
  });

  it('returns stable problems for disallowed models, concurrent turns, and deletion mismatch', async () => {
    const { app, adapter } = await application();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'not-allowed', reasoning_level: 'low' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'MODEL_NOT_ALLOWED' });
    adapter.enqueue({
      delayMs: 500,
      envelope: { status: 'completed', message: 'done', result_refs: [] },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'one' },
      payload: { api_version: '1.0', kind: 'message', content: 'one', source_refs: [] },
    });
    expect(first.statusCode).toBe(202);
    const archiveActive = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { api_version: '1.0', archived: true },
    });
    expect(archiveActive.json()).toMatchObject({ code: 'SESSION_BUSY', status: 409 });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'two' },
      payload: { api_version: '1.0', kind: 'message', content: 'two', source_refs: [] },
    });
    expect(second.json()).toMatchObject({ code: 'SESSION_BUSY', status: 409 });
    const mismatch = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${sessionId}`,
      headers: { 'idempotency-key': 'delete' },
      payload: { api_version: '1.0', confirm_session_id: 'different' },
    });
    expect(mismatch.json()).toMatchObject({ code: 'SESSION_STATE_INVALID', status: 409 });
    await app.close();
  });

  it('persists multi-question drafts and resumes the same thread after service restart', async () => {
    const firstApp = await application();
    const { app, adapter, runtime } = firstApp;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    adapter.enqueue({
      threadId: 'stable-thread',
      envelope: {
        status: 'needs_input',
        message: 'need choices',
        questions: [
          {
            id: 'timezone',
            question: 'Timezone?',
            options: ['Asia/Shanghai'],
            allow_free_text: false,
            required: true,
          },
          { id: 'target', question: 'Target?', options: [], allow_free_text: true, required: true },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'ask' },
      payload: { api_version: '1.0', kind: 'message', content: 'analyze', source_refs: [] },
    });
    await runtime.waitForIdle(sessionId);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}` });
    const questionSetId = detail.json().pending_question_set.question_set_id as string;
    expect(detail.json().pending_question_set.draft_answers).toEqual([]);
    const draft = await app.inject({
      method: 'PUT',
      url: `/api/v1/sessions/${sessionId}/question-sets/${questionSetId}/draft`,
      payload: {
        api_version: '1.0',
        draft_answers: [{ question_id: 'timezone', answer: 'Asia/Shanghai' }],
      },
    });
    expect(draft.json().question_set.draft_answers).toHaveLength(1);
    const config = firstApp.runtime.config;
    await app.close();

    const secondApp = await application(config);
    secondApp.adapter.enqueue({
      threadId: 'stable-thread',
      envelope: { status: 'completed', message: 'resumed', result_refs: [] },
    });
    const restored = await secondApp.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
    });
    expect(restored.json().pending_question_set.draft_answers).toHaveLength(1);
    await secondApp.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: { 'idempotency-key': 'answer' },
      payload: {
        api_version: '1.0',
        kind: 'question_answers',
        question_set_id: questionSetId,
        answers: [
          { question_id: 'timezone', answer: 'Asia/Shanghai' },
          { question_id: 'target', answer: 'load' },
        ],
      },
    });
    await secondApp.runtime.waitForIdle(sessionId);
    expect(secondApp.adapter.requests[0]?.threadId).toBe('stable-thread');
    expect(secondApp.repository.requireSession(sessionId).status).toBe('idle');
    await secondApp.app.close();
  });

  it('replays more than one event page from Last-Event-ID and then keeps heartbeating', async () => {
    const { app, repository } = await application();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    const turn = repository.createTurn({
      sessionId,
      idempotencyKey: 'long-replay-turn',
      content: 'produce a long durable event history',
      sourceRefs: [],
    }).turn;
    repository.startTurn(turn.id);
    for (let index = 0; index < 1_005; index += 1) {
      repository.appendEvent({
        protocol_version: '1.0',
        session_id: sessionId,
        turn_id: turn.id,
        type: 'agent.activity',
        data: {
          activity_id: `activity-${index}`,
          kind: 'info',
          status: 'completed',
          summary: `event ${index}`,
        },
      });
    }
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const replay = await readSseUntil(
      `${address}/api/v1/sessions/${sessionId}/events`,
      'id: 1006',
      { 'last-event-id': '5' },
    );
    expect(replay).toContain('id: 6');
    expect(replay).toContain('id: 1006');
    expect(replay).not.toContain('id: 5\n');

    const heartbeat = await readSseUntil(
      `${address}/api/v1/sessions/${sessionId}/events?after_event_id=1006`,
      ': heartbeat ',
    );
    expect(heartbeat).toContain(': heartbeat ');
    await app.close();
  });

  it('removes multipart staging and database rows when the client connection aborts', async () => {
    const { app, repository, runtime } = await application();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const boundary = 'building-energy-aborted-upload';
    const prefix = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="api_version"',
      '',
      '1.0',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="partial.csv"',
      'Content-Type: text/csv',
      '',
      'timestamp,point_id,value_raw',
      '2026-08-10T00:00:00+08:00,load,',
    ].join('\r\n');
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(Number(address.port), address.hostname);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          [
            `POST /api/v1/sessions/${sessionId}/uploads HTTP/1.1`,
            `Host: ${address.host}`,
            `Content-Type: multipart/form-data; boundary=${boundary}`,
            'Idempotency-Key: aborted-multipart',
            'Content-Length: 1000000',
            'Connection: close',
            '',
            prefix,
          ].join('\r\n'),
        );
        setTimeout(() => socket.destroy(), 30);
      });
      socket.once('close', () => resolve());
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(repository.uploads(sessionId)).toEqual([]);
    expect(await readdir(runtime.workspaces.paths(sessionId).inputs)).toEqual([]);
    await app.close();
  });

  it('disconnects an SSE consumer that stays backpressured past the configured timeout', async () => {
    const { app, repository, runtime } = await application();
    runtime.config.slowConsumerTimeoutMs = 30;
    runtime.config.heartbeatMs = 60_000;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    const turn = repository.createTurn({
      sessionId,
      idempotencyKey: 'slow-consumer-turn',
      content: 'stream events',
      sourceRefs: [],
    }).turn;
    repository.startTurn(turn.id);
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const socket = net.createConnection(Number(address.port), address.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          [
            `GET /api/v1/sessions/${sessionId}/events?after_event_id=1 HTTP/1.1`,
            `Host: ${address.host}`,
            'Accept: text/event-stream',
            'Connection: keep-alive',
            '',
            '',
          ].join('\r\n'),
        );
        socket.pause();
        resolve();
      });
    });
    for (
      let attempt = 0;
      attempt < 50 && runtime.events.listenerCount(sessionId) === 0;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.events.listenerCount(sessionId)).toBe(1);
    for (let index = 0; index < 800; index += 1) {
      const event = repository.appendEvent({
        protocol_version: '1.0',
        session_id: sessionId,
        turn_id: turn.id,
        type: 'agent.activity',
        data: {
          activity_id: `slow-${index}`,
          kind: 'info',
          status: 'completed',
          summary: `slow consumer event ${index}`,
          detail: 'x'.repeat(8_000),
        },
      });
      runtime.events.publish(event);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.events.listenerCount(sessionId)).toBe(0);
    socket.destroy();
    await app.close();
  }, 10_000);

  it('terminates live SSE streams before graceful server shutdown', async () => {
    const { app, runtime } = await application();
    runtime.config.heartbeatMs = 60_000;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: { api_version: '1.0', model: 'test-model', reasoning_level: 'low' },
    });
    const sessionId = created.json().session.session_id as string;
    const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
    const socket = net.createConnection(Number(address.port), address.hostname);
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', () => resolve());
      socket.once('connect', () => {
        socket.write(
          [
            `GET /api/v1/sessions/${sessionId}/events HTTP/1.1`,
            `Host: ${address.host}`,
            'Accept: text/event-stream',
            'Connection: keep-alive',
            '',
            '',
          ].join('\r\n'),
        );
      });
    });
    expect(runtime.events.listenerCount(sessionId)).toBe(1);

    const closing = app.close();
    const timely = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
    if (!timely) socket.destroy();
    await closing;

    expect(timely).toBe(true);
    expect(runtime.events.listenerCount(sessionId)).toBe(0);
  });

  it('serves the production SPA without swallowing unknown API routes', async () => {
    const initial = await application();
    const config = initial.runtime.config;
    await initial.app.close();
    const webDist = path.join(config.projectRoot, 'apps/web/dist');
    await mkdir(webDist, { recursive: true });
    await writeFile(
      path.join(webDist, 'index.html'),
      '<!doctype html><title>Building Energy</title><script type="module" src="/assets/app.js"></script>',
    );
    await mkdir(path.join(webDist, 'assets'), { recursive: true });
    await writeFile(path.join(webDist, 'assets/app.js'), 'console.log("asset");');
    const production = await application(config);
    const root = await production.app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('/assets/app.js');
    const spa = await production.app.inject({
      method: 'GET',
      url: '/conversation/example',
      headers: { accept: 'text/html' },
    });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('Building Energy');
    const asset = await production.app.inject({
      method: 'GET',
      url: '/assets/app.js',
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
    const missingApi = await production.app.inject({
      method: 'GET',
      url: '/api/v1/not-a-route',
      headers: { accept: 'text/html' },
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers['content-type']).toContain('application/problem+json');
    expect(missingApi.json()).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await production.app.close();
  });
});

async function readSse(url: string): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  controller.abort();
  return new TextDecoder().decode(value);
}

async function readSseUntil(
  url: string,
  marker: string,
  headers?: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let content = '';
    while (!content.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) break;
      content += decoder.decode(value, { stream: true });
    }
    controller.abort();
    return content;
  } finally {
    clearTimeout(timeout);
  }
}
