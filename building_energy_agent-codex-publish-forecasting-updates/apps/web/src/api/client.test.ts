import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProblem, createApiClient } from './client';

const now = '2026-08-10T01:00:00.000Z';
const sha256 = 'a'.repeat(64);

function detail(
  contentUrl = '/api/v1/artifacts/artifact-1/content?file=0',
  skillJobs: unknown[] = [],
) {
  return {
    api_version: '1.0',
    session: {
      session_id: 'session-1',
      title: '负荷预测',
      status: 'idle',
      model: 'gpt-5.6-sol',
      reasoning_level: 'xhigh',
      model_locked: true,
      archived: false,
      created_at: now,
      updated_at: now,
    },
    messages: [],
    turns: [
      {
        turn_id: 'turn-1',
        status: 'completed',
        started_at: now,
        finished_at: now,
        result_refs: [
          {
            artifact_id: 'artifact-1',
            artifact_type: 'ForecastBundle',
            status: 'succeeded',
            manifest_url: '/api/v1/artifacts/artifact-1',
          },
        ],
      },
    ],
    sources: [],
    artifacts: [
      {
        schema_version: '1.0',
        artifact_id: 'artifact-1',
        artifact_type: 'ForecastBundle',
        producer: { skill_name: 'building-energy-load-forecasting', job_id: 'job-1' },
        source_ids: [],
        status: 'succeeded',
        files: [
          {
            name: 'forecast.csv',
            media_type: 'text/csv',
            size_bytes: 64,
            sha256,
            role: 'forecast-data',
            content_url: contentUrl,
          },
        ],
        summary: { horizon_hours: 24 },
        warnings: [],
      },
    ],
    skill_jobs: skillJobs,
    last_event_id: '9',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApiClient contract boundaries', () => {
  it('starts from zero so persisted SSE can rebuild activity history absent from the snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(detail()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const session = await createApiClient().getSession('session-1');

    expect(session.lastEventId).toBe(9);
    expect(session.skillJobs).toEqual([]);
    expect(session.turns[0]?.results[0]).toMatchObject({
      artifactId: 'artifact-1',
      manifestUrl: '/api/v1/artifacts/artifact-1',
    });
  });

  it('restores persisted Skill stage, progress, warnings, and Artifact references', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            detail(undefined, [
              {
                turn_id: 'turn-1',
                skill_name: 'building-energy-load-forecasting',
                job_id: 'job-1',
                status: 'partial',
                stage: '生成预测结果',
                progress: { completed: 3, total: 4, unit: '阶段' },
                warnings: ['缺少一个可用点位。'],
                result_refs: [
                  {
                    artifact_id: 'artifact-1',
                    artifact_type: 'ForecastBundle',
                    status: 'succeeded',
                    manifest_url: '/api/v1/artifacts/artifact-1',
                  },
                ],
              },
            ]),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const session = await createApiClient().getSession('session-1');

    expect(session.skillJobs[0]).toMatchObject({
      stage: '生成预测结果',
      progress: { completed: 3, total: 4, unit: '阶段' },
      warnings: ['缺少一个可用点位。'],
      resultRefs: [{ artifactId: 'artifact-1', manifestUrl: '/api/v1/artifacts/artifact-1' }],
    });
  });

  it('rejects an external artifact URL instead of exposing it to the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(detail('https://example.invalid/private.csv')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(createApiClient().getSession('session-1')).rejects.toBeInstanceOf(ApiProblem);
  });

  it('requests archived history and patches the session through the shared contract', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            api_version: '1.0',
            sessions: [{ ...detail().session, archived: true }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            api_version: '1.0',
            session: { ...detail().session, title: '冷站历史分析', archived: true },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient();

    const archived = await client.listSessions({ archived: true });
    const updated = await client.updateSession('session-1', {
      title: '冷站历史分析',
      archived: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/sessions?archived=true');
    expect(archived).toMatchObject([{ id: 'session-1', archived: true }]);
    const [, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(updateInit.method).toBe('PATCH');
    expect(JSON.parse(String(updateInit.body))).toEqual({
      api_version: '1.0',
      title: '冷站历史分析',
      archived: true,
    });
    expect(updated).toMatchObject({ title: '冷站历史分析', archived: true });
  });

  it('persists a pre-turn model and reasoning selection through the session patch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          api_version: '1.0',
          session: {
            ...detail().session,
            model: 'gpt-5.6-terra',
            reasoning_level: 'medium',
            model_locked: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const updated = await createApiClient().updateSession('session-1', {
      model: 'gpt-5.6-terra',
      reasoning: 'medium',
    });

    const [, updateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(updateInit.body))).toEqual({
      api_version: '1.0',
      model: 'gpt-5.6-terra',
      reasoning_level: 'medium',
    });
    expect(updated).toMatchObject({ model: 'gpt-5.6-terra', reasoning: 'medium' });
  });

  it('submits all answers through one question-group request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          api_version: '1.0',
          turn: { turn_id: 'turn-2', status: 'queued', result_refs: [] },
          replayed: false,
        }),
        { status: 202, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createApiClient().sendMessage('session-1', {
      content: '已提交问题组回答。',
      sourceRefs: [],
      questionSetId: 'questions-1',
      answers: { timezone: 'Asia/Shanghai', target: '冷站总表' },
      idempotencyKey: 'answers-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'idempotency-key': 'answers-1' });
    expect(JSON.parse(String(init.body))).toEqual({
      api_version: '1.0',
      kind: 'question_answers',
      question_set_id: 'questions-1',
      answers: [
        { question_id: 'timezone', answer: 'Asia/Shanghai' },
        { question_id: 'target', answer: '冷站总表' },
      ],
    });
  });
});
