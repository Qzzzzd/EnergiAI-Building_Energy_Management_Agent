import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentTurnEnvelopeSchema,
  ArtifactManifestSchema,
  BE_EXECUTION_PLAN_PREFIX,
  BE_SKILL_EVENT_PREFIX,
  CreateSessionRequestSchema,
  decodeSkillEventLine,
  encodeSkillEventLine,
  ExecutionPlanSchema,
  isSessionStatusTransition,
  isSkillJobStatusTransition,
  isTurnStatusTransition,
  ListSessionsQuerySchema,
  parseContract,
  parseSkillEventLine,
  parseVersionedContract,
  PersistedSkillJobStateSchema,
  ProblemDetailsSchema,
  SessionDetailResponseSchema,
  SkillEventSchema,
  SkillLifecycleCommandSchema,
  SseEventSchema,
  UpdateSessionRequestSchema,
  UpdateQuestionDraftRequestSchema,
} from '../src/index.js';

function golden(name: string): unknown {
  const path = fileURLToPath(new URL(`./golden/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

describe('AgentTurnEnvelope', () => {
  it('accepts the multi-question needs_input golden contract', () => {
    const parsed = AgentTurnEnvelopeSchema.parse(golden('agent-turn-needs-input.json'));
    expect(parsed.status).toBe('needs_input');
    if (parsed.status === 'needs_input') {
      expect(parsed.questions).toHaveLength(2);
    }
  });

  it('rejects duplicate ids, impossible questions, empty lists, and extra fields', () => {
    const base = golden('agent-turn-needs-input.json') as Record<string, unknown>;
    const questions = base.questions as Array<Record<string, unknown>>;
    expect(
      AgentTurnEnvelopeSchema.safeParse({
        ...base,
        questions: [questions[0], { ...questions[1], id: questions[0]?.id }],
      }).success,
    ).toBe(false);
    expect(
      AgentTurnEnvelopeSchema.safeParse({
        status: 'needs_input',
        questions: [
          {
            id: 'q',
            question: '需要答案',
            options: [],
            allow_free_text: false,
            required: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AgentTurnEnvelopeSchema.safeParse({ status: 'needs_input', questions: [] }).success,
    ).toBe(false);
    expect(
      AgentTurnEnvelopeSchema.safeParse({ ...base, internal_path: '/tmp/private' }).success,
    ).toBe(false);
  });

  it('does not accept SDK/runtime failures as business envelopes', () => {
    expect(
      AgentTurnEnvelopeSchema.safeParse({ status: 'failed', message: 'failed', result_refs: [] })
        .success,
    ).toBe(false);
  });
});

describe('public state machines', () => {
  it('permits declared progress and makes terminal turn states irreversible', () => {
    expect(isSessionStatusTransition('empty', 'running')).toBe(true);
    expect(isSessionStatusTransition('running', 'deleting')).toBe(false);
    expect(isTurnStatusTransition('running', 'needs_input')).toBe(true);
    expect(isTurnStatusTransition('needs_input', 'queued')).toBe(true);
    expect(isTurnStatusTransition('completed', 'running')).toBe(false);
    expect(isTurnStatusTransition('cancelled', 'cancelled')).toBe(true);
  });

  it('allows Skill resume but not terminal resurrection', () => {
    expect(isSkillJobStatusTransition('needs_input', 'running')).toBe(true);
    expect(isSkillJobStatusTransition('running', 'cancelling')).toBe(true);
    expect(isSkillJobStatusTransition('cancelled', 'running')).toBe(false);
  });
});

describe('REST contracts and stable problem details', () => {
  it('accepts a golden request and rejects an incompatible old shape', () => {
    expect(CreateSessionRequestSchema.parse(golden('rest-create-session.json'))).toEqual(
      golden('rest-create-session.json'),
    );
    expect(
      CreateSessionRequestSchema.safeParse({
        api_version: '1.0',
        title: 'legacy request',
        model_name: 'gpt-5.6',
        reasoning: 'high',
      }).success,
    ).toBe(false);
  });

  it('requires a meaningful session update and explicit archive collection filter', () => {
    expect(
      UpdateSessionRequestSchema.parse({ api_version: '1.0', title: '  冷站历史分析  ' }),
    ).toMatchObject({ title: '冷站历史分析' });
    expect(UpdateSessionRequestSchema.parse({ api_version: '1.0', archived: false })).toMatchObject(
      { archived: false },
    );
    expect(
      UpdateSessionRequestSchema.parse({
        api_version: '1.0',
        model: 'gpt-5.6-sol',
        reasoning_level: 'xhigh',
      }),
    ).toMatchObject({ model: 'gpt-5.6-sol', reasoning_level: 'xhigh' });
    expect(
      UpdateSessionRequestSchema.safeParse({ api_version: '1.0', model: 'gpt-5.6-sol' }).success,
    ).toBe(false);
    expect(UpdateSessionRequestSchema.safeParse({ api_version: '1.0' }).success).toBe(false);
    expect(ListSessionsQuerySchema.parse({ archived: 'true' }).archived).toBe('true');
    expect(ListSessionsQuerySchema.safeParse({ archived: 'yes' }).success).toBe(false);
  });

  it('maps invalid input without leaking supplied values', () => {
    const sensitiveValue = 'secret-token-'.repeat(20);
    const result = parseContract(
      CreateSessionRequestSchema,
      { ...(golden('rest-create-session.json') as object), model: sensitiveValue },
      { correlationId: 'corr-validation', instance: '/api/v1/sessions' },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(ProblemDetailsSchema.parse(result.problem).code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(result.problem)).not.toContain('secret-token');
      expect(result.problem.invalid_params?.[0]?.reason).toBe('too_big');
    }
  });

  it('maps unknown minor and incompatible major API versions deterministically', () => {
    const request = golden('rest-create-session.json') as Record<string, unknown>;
    const unknown = parseVersionedContract(
      CreateSessionRequestSchema,
      { ...request, api_version: '1.1' },
      {
        protocol: 'api',
        versionField: 'api_version',
        correlationId: 'corr-version-1',
      },
    );
    const incompatible = parseVersionedContract(
      CreateSessionRequestSchema,
      { ...request, api_version: '2.0' },
      {
        protocol: 'api',
        versionField: 'api_version',
        correlationId: 'corr-version-2',
      },
    );
    expect(unknown.success || unknown.problem.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
    expect(incompatible.success || incompatible.problem.code).toBe('INCOMPATIBLE_PROTOCOL_VERSION');
  });

  it('accepts a golden Problem Details document and rejects unstable codes', () => {
    expect(ProblemDetailsSchema.parse(golden('problem-details.json'))).toEqual(
      golden('problem-details.json'),
    );
    expect(
      ProblemDetailsSchema.safeParse({
        ...(golden('problem-details.json') as object),
        code: 'SOMETHING_NEW_AND_UNDECLARED',
      }).success,
    ).toBe(false);
  });

  it('persists partial or empty question drafts without accepting duplicate question ids', () => {
    expect(
      UpdateQuestionDraftRequestSchema.safeParse({
        api_version: '1.0',
        draft_answers: [{ question_id: 'target-point', answer: 'meter-a' }],
      }).success,
    ).toBe(true);
    expect(
      UpdateQuestionDraftRequestSchema.safeParse({ api_version: '1.0', draft_answers: [] }).success,
    ).toBe(true);
    expect(
      UpdateQuestionDraftRequestSchema.safeParse({
        api_version: '1.0',
        draft_answers: [
          { question_id: 'target-point', answer: 'meter-a' },
          { question_id: 'target-point', answer: 'meter-b' },
        ],
      }).success,
    ).toBe(false);
  });

  it('returns immutable sources and artifact resources in session restoration', () => {
    const restored = SessionDetailResponseSchema.parse({
      api_version: '1.0',
      session: {
        session_id: 'session-001',
        title: '恢复测试',
        status: 'needs_input',
        model: 'gpt-5.6',
        reasoning_level: 'high',
        model_locked: true,
        archived: false,
        created_at: '2026-08-10T00:00:00+08:00',
        updated_at: '2026-08-10T00:01:00+08:00',
      },
      messages: [],
      turns: [],
      sources: [
        {
          source_ref: 'source-001',
          original_name: 'energy.csv',
          media_type: 'text/csv',
          size_bytes: 128,
          sha256: 'b'.repeat(64),
          created_at: '2026-08-10T00:00:00+08:00',
        },
      ],
      artifacts: [
        {
          schema_version: '1.0',
          artifact_id: 'artifact-001',
          artifact_type: 'forecast.result',
          producer: {
            skill_name: 'building-energy-load-forecasting',
            job_id: 'job-001',
          },
          source_ids: ['source-001'],
          status: 'succeeded',
          files: [
            {
              name: 'result.json',
              media_type: 'application/json',
              size_bytes: 64,
              sha256: 'a'.repeat(64),
              role: 'result',
              content_url: '/api/v1/artifacts/artifact-001/content',
            },
          ],
          summary: { horizon_hours: 24 },
          warnings: [],
        },
      ],
      skill_jobs: [
        {
          turn_id: 'turn-001',
          skill_name: 'building-energy-load-forecasting',
          job_id: 'job-001',
          status: 'partial',
          stage: '生成预测结果',
          progress: { completed: 3, total: 4, unit: '阶段' },
          warnings: ['缺少一个可用点位。'],
          result_refs: [
            {
              artifact_id: 'artifact-001',
              artifact_type: 'forecast.result',
              status: 'succeeded',
              manifest_url: '/api/v1/artifacts/artifact-001',
            },
          ],
        },
      ],
      pending_question_set: {
        question_set_id: 'questions-001',
        turn_id: 'turn-001',
        status: 'pending',
        questions: [
          {
            id: 'target-point',
            question: '目标点位',
            options: ['meter-a'],
            allow_free_text: true,
            required: true,
          },
        ],
        draft_answers: [{ question_id: 'target-point', answer: 'meter-a' }],
        created_at: '2026-08-10T00:01:00+08:00',
      },
      last_event_id: '42',
    });
    expect(restored.sources[0]?.source_ref).toBe('source-001');
    expect(restored.artifacts[0]?.artifact_id).toBe('artifact-001');
    expect(restored.pending_question_set?.draft_answers[0]?.answer).toBe('meter-a');
  });
});

describe('SSE protocol', () => {
  it('accepts the input.required golden event', () => {
    const parsed = SseEventSchema.parse(golden('sse-input-required-event.json'));
    expect(parsed.type).toBe('input.required');
  });

  it('rejects an unknown event type and malformed monotonic cursor', () => {
    const event = golden('sse-input-required-event.json') as Record<string, unknown>;
    expect(SseEventSchema.safeParse({ ...event, type: 'sdk.item.updated' }).success).toBe(false);
    expect(SseEventSchema.safeParse({ ...event, event_id: '0' }).success).toBe(false);
  });

  it('maps unknown and incompatible event protocol versions', () => {
    const event = golden('sse-input-required-event.json') as Record<string, unknown>;
    for (const [version, code] of [
      ['1.9', 'UNSUPPORTED_PROTOCOL_VERSION'],
      ['2.0', 'INCOMPATIBLE_PROTOCOL_VERSION'],
    ] as const) {
      const result = parseVersionedContract(
        SseEventSchema,
        { ...event, protocol_version: version },
        {
          protocol: 'sse',
          versionField: 'protocol_version',
          correlationId: `corr-sse-${version}`,
        },
      );
      expect(result.success || result.problem.code).toBe(code);
    }
  });

  it('validates an Agent-declared execution plan and typed SSE event', () => {
    const plan = {
      plan_id: 'plan-001',
      title: '综合能源分析',
      nodes: [
        {
          id: 'node-parse',
          title: '解析输入数据',
          skill_name: 'building-energy-data-parsing',
          depends_on: [],
        },
        {
          id: 'node-quality',
          title: '评估数据质量',
          skill_name: 'building-energy-data-quality',
          depends_on: ['node-parse'],
          parallel_group: 'result-analysis',
        },
      ],
    };
    expect(ExecutionPlanSchema.parse(plan)).toEqual(plan);
    expect(BE_EXECUTION_PLAN_PREFIX).toBe('BE_EXECUTION_PLAN ');
    expect(
      SseEventSchema.parse({
        protocol_version: '1.0',
        event_id: '43',
        session_id: 'session-001',
        turn_id: 'turn-001',
        occurred_at: '2026-08-10T00:01:00+08:00',
        type: 'execution.plan',
        data: { plan },
      }),
    ).toMatchObject({ type: 'execution.plan', data: { plan } });
    expect(
      ExecutionPlanSchema.safeParse({
        ...plan,
        nodes: [{ ...plan.nodes[0], depends_on: ['node-quality'] }, plan.nodes[1]],
      }).success,
    ).toBe(false);
    expect(
      ExecutionPlanSchema.safeParse({
        ...plan,
        nodes: [{ ...plan.nodes[0], depends_on: ['missing-node'] }, plan.nodes[1]],
      }).success,
    ).toBe(false);
  });
});

describe('Skill lifecycle and BE_SKILL_EVENT', () => {
  it('accepts all five generic lifecycle commands and rejects unknown operations', () => {
    const common = {
      protocol_version: '1.0',
      request_id: 'request-001',
      requested_at: '2026-08-10T00:00:00+08:00',
    };
    const commands = [
      {
        ...common,
        operation: 'start',
        session_id: 'session-001',
        turn_id: 'turn-001',
        request: { bundle_id: 'dataset-001' },
      },
      { ...common, operation: 'status', job_id: 'job-001' },
      { ...common, operation: 'result', job_id: 'job-001' },
      {
        ...common,
        operation: 'resume',
        job_id: 'job-001',
        answers: [{ question_id: 'timezone', answer: 'Asia/Shanghai' }],
      },
      { ...common, operation: 'cancel', job_id: 'job-001', reason: 'user request' },
    ];
    expect(
      commands.every((command) => SkillLifecycleCommandSchema.safeParse(command).success),
    ).toBe(true);
    expect(SkillLifecycleCommandSchema.safeParse({ ...common, operation: 'restart' }).success).toBe(
      false,
    );
  });

  it('round-trips the golden event with the fixed JSONL prefix', () => {
    const event = SkillEventSchema.parse(golden('skill-progress-event.json'));
    const line = encodeSkillEventLine(event);
    expect(line.startsWith(BE_SKILL_EVENT_PREFIX)).toBe(true);
    expect(decodeSkillEventLine(line)).toEqual(event);
    expect(decodeSkillEventLine('ordinary diagnostic output')).toBeNull();
  });

  it('rejects malformed progress and malformed prefixed JSON', () => {
    const event = golden('skill-progress-event.json') as Record<string, unknown>;
    expect(
      SkillEventSchema.safeParse({
        ...event,
        progress: { completed: 5, total: 4, unit: 'stage' },
      }).success,
    ).toBe(false);
    expect(() => decodeSkillEventLine(`${BE_SKILL_EVENT_PREFIX}{bad json`)).toThrow();
    const malformed = parseSkillEventLine(`${BE_SKILL_EVENT_PREFIX}{bad json`, 'corr-jsonl');
    expect(malformed.kind === 'problem' && malformed.problem.code).toBe('SKILL_PROTOCOL_ERROR');
  });

  it('maps unknown and incompatible Skill protocol versions', () => {
    const event = golden('skill-progress-event.json') as Record<string, unknown>;
    for (const [version, code] of [
      ['1.5', 'UNSUPPORTED_PROTOCOL_VERSION'],
      ['3.0', 'INCOMPATIBLE_PROTOCOL_VERSION'],
    ] as const) {
      const result = parseVersionedContract(
        SkillEventSchema,
        { ...event, protocol_version: version },
        {
          protocol: 'skill',
          versionField: 'protocol_version',
          correlationId: `corr-skill-${version}`,
        },
      );
      expect(result.success || result.problem.code).toBe(code);
    }
  });

  it('requires persisted recovery state for needs_input and failed jobs', () => {
    const common = {
      protocol_version: '1.0',
      skill_name: 'building-energy-data-quality',
      job_id: 'job-002',
      session_id: 'session-001',
      turn_id: 'turn-001',
      stage: 'quality-profile',
      warnings: [],
      result_refs: [],
      created_at: '2026-08-10T00:00:00+08:00',
      updated_at: '2026-08-10T00:01:00+08:00',
    };
    expect(
      PersistedSkillJobStateSchema.safeParse({ ...common, status: 'needs_input' }).success,
    ).toBe(false);
    expect(PersistedSkillJobStateSchema.safeParse({ ...common, status: 'failed' }).success).toBe(
      false,
    );
  });
});

describe('Artifact manifest', () => {
  it('accepts the golden manifest and unknown artifact types', () => {
    expect(ArtifactManifestSchema.parse(golden('artifact-manifest.json'))).toEqual(
      golden('artifact-manifest.json'),
    );
    expect(
      ArtifactManifestSchema.safeParse({
        ...(golden('artifact-manifest.json') as object),
        artifact_type: 'third-party.custom-result',
      }).success,
    ).toBe(true);
  });

  it.each(['/etc/passwd', '../escape.json', 'result/../../escape.json', 'C:\\secret.txt'])(
    'rejects an uncontrolled file path: %s',
    (relativePath) => {
      const manifest = golden('artifact-manifest.json') as Record<string, unknown>;
      const files = manifest.files as Array<Record<string, unknown>>;
      expect(
        ArtifactManifestSchema.safeParse({
          ...manifest,
          files: [{ ...files[0], relative_path: relativePath }],
        }).success,
      ).toBe(false);
    },
  );

  it('rejects bad hashes, unknown schema versions, and incompatible major versions', () => {
    const manifest = golden('artifact-manifest.json') as Record<string, unknown>;
    const files = manifest.files as Array<Record<string, unknown>>;
    expect(
      ArtifactManifestSchema.safeParse({
        ...manifest,
        files: [{ ...files[0], sha256: 'not-a-sha' }],
      }).success,
    ).toBe(false);

    const unknown = parseVersionedContract(
      ArtifactManifestSchema,
      { ...manifest, schema_version: '1.1' },
      {
        protocol: 'artifact',
        versionField: 'schema_version',
        correlationId: 'corr-artifact-1',
      },
    );
    const incompatible = parseVersionedContract(
      ArtifactManifestSchema,
      { ...manifest, schema_version: '2.0' },
      {
        protocol: 'artifact',
        versionField: 'schema_version',
        correlationId: 'corr-artifact-2',
      },
    );
    expect(unknown.success || unknown.problem.code).toBe('UNSUPPORTED_PROTOCOL_VERSION');
    expect(incompatible.success || incompatible.problem.code).toBe('INCOMPATIBLE_PROTOCOL_VERSION');
  });

  it('rejects duplicate manifest paths and source ids', () => {
    const manifest = golden('artifact-manifest.json') as Record<string, unknown>;
    const files = manifest.files as Array<Record<string, unknown>>;
    expect(
      ArtifactManifestSchema.safeParse({ ...manifest, files: [files[0], files[0]] }).success,
    ).toBe(false);
    expect(
      ArtifactManifestSchema.safeParse({
        ...manifest,
        source_ids: ['source-001', 'source-001'],
      }).success,
    ).toBe(false);
  });
});
