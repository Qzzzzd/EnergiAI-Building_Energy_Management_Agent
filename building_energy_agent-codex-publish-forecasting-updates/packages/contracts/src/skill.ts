import { z } from 'zod';

import { QuestionAnswersSchema, QuestionListSchema } from './agent-turn.js';
import { ArtifactRefSchema } from './artifact.js';
import {
  ArtifactIdSchema,
  JobIdSchema,
  JsonObjectSchema,
  OpaqueIdSchema,
  SafeRelativePathSchema,
  SessionIdSchema,
  SkillJobStatusSchema,
  TimestampSchema,
  TurnIdSchema,
} from './base.js';
import {
  parseVersionedContract,
  ProblemDetailsSchema,
  skillProtocolProblem,
  type ProblemDetails,
} from './problem.js';
import { SkillProtocolVersionSchema } from './versions.js';

export const BE_SKILL_EVENT_PREFIX = 'BE_SKILL_EVENT ' as const;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const SkillCommandBaseSchema = z.object({
  protocol_version: SkillProtocolVersionSchema,
  request_id: OpaqueIdSchema,
  requested_at: TimestampSchema,
});

export const SkillStartCommandSchema = SkillCommandBaseSchema.extend({
  operation: z.literal('start'),
  session_id: SessionIdSchema,
  turn_id: TurnIdSchema,
  request: JsonObjectSchema,
}).strict();

export const SkillStatusCommandSchema = SkillCommandBaseSchema.extend({
  operation: z.literal('status'),
  job_id: JobIdSchema,
}).strict();

export const SkillResultCommandSchema = SkillCommandBaseSchema.extend({
  operation: z.literal('result'),
  job_id: JobIdSchema,
}).strict();

export const SkillResumeCommandSchema = SkillCommandBaseSchema.extend({
  operation: z.literal('resume'),
  job_id: JobIdSchema,
  answers: QuestionAnswersSchema,
}).strict();

export const SkillCancelCommandSchema = SkillCommandBaseSchema.extend({
  operation: z.literal('cancel'),
  job_id: JobIdSchema,
  reason: z.string().min(1).max(1_000).optional(),
}).strict();

export const SkillLifecycleCommandSchema = z.discriminatedUnion('operation', [
  SkillStartCommandSchema,
  SkillStatusCommandSchema,
  SkillResultCommandSchema,
  SkillResumeCommandSchema,
  SkillCancelCommandSchema,
]);

export const SkillProgressSchema = z
  .object({
    completed: z.number().nonnegative().finite(),
    total: z.number().positive().finite(),
    unit: z.string().min(1).max(64),
  })
  .strict()
  .refine((progress) => progress.completed <= progress.total, {
    message: 'completed progress cannot exceed total',
    path: ['completed'],
  });

const SkillEventBaseSchema = z.object({
  protocol_version: SkillProtocolVersionSchema,
  event_id: OpaqueIdSchema,
  skill_name: SkillNameSchema,
  job_id: JobIdSchema,
  stage: z.string().min(1).max(256),
  timestamp: TimestampSchema,
  warnings: z.array(z.string().min(1).max(2_000)),
});

export const SkillStartedEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('started'),
  progress: SkillProgressSchema.optional(),
  payload: JsonObjectSchema,
}).strict();

export const SkillProgressEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('progress'),
  progress: SkillProgressSchema,
  payload: JsonObjectSchema,
}).strict();

export const SkillNeedsInputEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('needs_input'),
  questions: QuestionListSchema,
  payload: JsonObjectSchema,
}).strict();

export const SkillArtifactEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('artifact'),
  artifact_id: ArtifactIdSchema,
  manifest_relative_path: SafeRelativePathSchema,
  payload: JsonObjectSchema,
}).strict();

export const SkillCompletedEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('completed'),
  outcome: z.enum(['succeeded', 'partial']),
  result_refs: z.array(ArtifactRefSchema),
  payload: JsonObjectSchema,
}).strict();

export const SkillFailedEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('failed'),
  error: ProblemDetailsSchema,
  payload: JsonObjectSchema,
}).strict();

export const SkillCancelledEventSchema = SkillEventBaseSchema.extend({
  kind: z.literal('cancelled'),
  reason: z.string().min(1).max(1_000).optional(),
  payload: JsonObjectSchema,
}).strict();

export const SkillEventSchema = z.discriminatedUnion('kind', [
  SkillStartedEventSchema,
  SkillProgressEventSchema,
  SkillNeedsInputEventSchema,
  SkillArtifactEventSchema,
  SkillCompletedEventSchema,
  SkillFailedEventSchema,
  SkillCancelledEventSchema,
]);

export const PersistedSkillJobStateSchema = z
  .object({
    protocol_version: SkillProtocolVersionSchema,
    skill_name: SkillNameSchema,
    job_id: JobIdSchema,
    session_id: SessionIdSchema,
    turn_id: TurnIdSchema,
    status: SkillJobStatusSchema,
    stage: z.string().min(1).max(256),
    progress: SkillProgressSchema.optional(),
    warnings: z.array(z.string().min(1).max(2_000)),
    questions: QuestionListSchema.optional(),
    result_refs: z.array(ArtifactRefSchema),
    error: ProblemDetailsSchema.optional(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict()
  .superRefine((state, context) => {
    if (state.status === 'needs_input' && (!state.questions || state.questions.length === 0)) {
      context.addIssue({
        code: 'custom',
        path: ['questions'],
        message: 'needs_input jobs must persist questions',
      });
    }
    if (state.status === 'failed' && state.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'failed jobs must persist an error',
      });
    }
  });

export type SkillLifecycleCommand = z.infer<typeof SkillLifecycleCommandSchema>;
export type SkillEvent = z.infer<typeof SkillEventSchema>;
export type PersistedSkillJobState = z.infer<typeof PersistedSkillJobStateSchema>;
export type SkillEventLineResult =
  | { kind: 'log' }
  | { kind: 'event'; event: SkillEvent }
  | { kind: 'problem'; problem: ProblemDetails };

export function encodeSkillEventLine(event: SkillEvent): string {
  return `${BE_SKILL_EVENT_PREFIX}${JSON.stringify(SkillEventSchema.parse(event))}`;
}

export function decodeSkillEventLine(line: string): SkillEvent | null {
  if (!line.startsWith(BE_SKILL_EVENT_PREFIX)) {
    return null;
  }
  const json = line.slice(BE_SKILL_EVENT_PREFIX.length);
  return SkillEventSchema.parse(JSON.parse(json) as unknown);
}

export function parseSkillEventLine(line: string, correlationId: string): SkillEventLineResult {
  if (!line.startsWith(BE_SKILL_EVENT_PREFIX)) {
    return { kind: 'log' };
  }

  let input: unknown;
  try {
    input = JSON.parse(line.slice(BE_SKILL_EVENT_PREFIX.length)) as unknown;
  } catch {
    return { kind: 'problem', problem: skillProtocolProblem(correlationId) };
  }

  const parsed = parseVersionedContract(SkillEventSchema, input, {
    protocol: 'skill',
    versionField: 'protocol_version',
    correlationId,
  });
  if (parsed.success) {
    return { kind: 'event', event: parsed.data };
  }
  if (
    parsed.problem.code === 'UNSUPPORTED_PROTOCOL_VERSION' ||
    parsed.problem.code === 'INCOMPATIBLE_PROTOCOL_VERSION'
  ) {
    return { kind: 'problem', problem: parsed.problem };
  }
  return {
    kind: 'problem',
    problem: skillProtocolProblem(correlationId, parsed.problem.invalid_params),
  };
}
