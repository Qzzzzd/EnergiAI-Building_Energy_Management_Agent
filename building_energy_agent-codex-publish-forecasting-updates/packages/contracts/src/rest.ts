import { z } from 'zod';

import { QuestionAnswersSchema, QuestionListSchema } from './agent-turn.js';
import { ArtifactRefSchema, ArtifactResourceSchema } from './artifact.js';
import { ExecutionPlanSchema } from './execution-plan.js';
import {
  IdempotencyKeySchema,
  MAX_UPLOAD_FILES,
  MessageIdSchema,
  OpaqueIdSchema,
  QuestionIdSchema,
  QuestionSetIdSchema,
  ReasoningLevelSchema,
  SessionIdSchema,
  SessionStatusSchema,
  Sha256Schema,
  SkillJobStatusSchema,
  SourceRefSchema,
  TimestampSchema,
  TurnIdSchema,
  TurnStatusSchema,
} from './base.js';
import { EventIdSchema } from './base.js';
import { ProblemDetailsSchema } from './problem.js';
import { SkillProgressSchema } from './skill.js';
import { PublicApiVersionSchema } from './versions.js';

const ApiRequestBaseSchema = z.object({ api_version: PublicApiVersionSchema });
const ApiResponseBaseSchema = z.object({ api_version: PublicApiVersionSchema });

export const SessionParamsSchema = z.object({ sessionId: SessionIdSchema }).strict();
export const TurnParamsSchema = z
  .object({ sessionId: SessionIdSchema, turnId: TurnIdSchema })
  .strict();
export const ArtifactParamsSchema = z.object({ artifactId: OpaqueIdSchema }).strict();

export const IdempotencyHeadersSchema = z
  .object({
    'idempotency-key': IdempotencyKeySchema,
  })
  .strict();

export const ReasoningSelectionSchema = z
  .object({
    model: z.string().min(1).max(128),
    reasoning_level: ReasoningLevelSchema,
  })
  .strict();

export const ModelCandidateSchema = z
  .object({
    id: z.string().min(1).max(128),
    display_name: z.string().min(1).max(200),
    reasoning_levels: z.array(ReasoningLevelSchema).min(1),
    default_reasoning_level: ReasoningLevelSchema,
    availability: z.enum(['available', 'unavailable', 'probing']),
    unavailable_reason: z.string().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((model, context) => {
    if (!model.reasoning_levels.includes(model.default_reasoning_level)) {
      context.addIssue({
        code: 'custom',
        path: ['default_reasoning_level'],
        message: 'default reasoning level must be allowed by the model',
      });
    }
    if (model.availability === 'unavailable' && model.unavailable_reason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['unavailable_reason'],
        message: 'unavailable models require a reason',
      });
    }
  });

export const ModelsResponseSchema = ApiResponseBaseSchema.extend({
  models: z.array(ModelCandidateSchema),
  default_model: z.string().min(1).max(128),
})
  .strict()
  .superRefine((response, context) => {
    const ids = response.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', path: ['models'], message: 'model ids must be unique' });
    }
    const defaultModel = response.models.find((model) => model.id === response.default_model);
    if (!defaultModel || defaultModel.availability !== 'available') {
      context.addIssue({
        code: 'custom',
        path: ['default_model'],
        message: 'default model must be present and available',
      });
    }
  });

export const CreateSessionRequestSchema = ApiRequestBaseSchema.extend({
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(128),
  reasoning_level: ReasoningLevelSchema,
}).strict();

export const SessionResourceSchema = z
  .object({
    session_id: SessionIdSchema,
    title: z.string().min(1).max(200),
    status: SessionStatusSchema,
    model: z.string().min(1).max(128),
    reasoning_level: ReasoningLevelSchema,
    model_locked: z.boolean(),
    archived: z.boolean(),
    active_turn_id: TurnIdSchema.optional(),
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .strict();

export const CreateSessionResponseSchema = ApiResponseBaseSchema.extend({
  session: SessionResourceSchema,
}).strict();

export const UpdateSessionRequestSchema = ApiRequestBaseSchema.extend({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
  model: z.string().min(1).max(128).optional(),
  reasoning_level: ReasoningLevelSchema.optional(),
})
  .strict()
  .superRefine((request, context) => {
    if (
      request.title === undefined &&
      request.archived === undefined &&
      request.model === undefined &&
      request.reasoning_level === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'at least one session field must be updated',
      });
    }
    if (request.model !== undefined && request.reasoning_level === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reasoning_level'],
        message: 'model changes require reasoning_level',
      });
    }
    if (request.model === undefined && request.reasoning_level !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'reasoning_level changes require model',
      });
    }
  });

export const UpdateSessionResponseSchema = ApiResponseBaseSchema.extend({
  session: SessionResourceSchema,
}).strict();

export const ListSessionsQuerySchema = z
  .object({
    search: z.string().min(1).max(200).optional(),
    archived: z.enum(['true', 'false']).optional(),
    cursor: OpaqueIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export const ListSessionsResponseSchema = ApiResponseBaseSchema.extend({
  sessions: z.array(SessionResourceSchema),
  next_cursor: OpaqueIdSchema.optional(),
}).strict();

export const SourceSnapshotSchema = z
  .object({
    source_ref: SourceRefSchema,
    original_name: z.string().min(1).max(255),
    media_type: z.enum([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
      'text/csv',
    ]),
    size_bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    created_at: TimestampSchema,
  })
  .strict();

export const MessageResourceSchema = z
  .object({
    message_id: MessageIdSchema,
    turn_id: TurnIdSchema,
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(100_000),
    source_refs: z.array(SourceRefSchema),
    result_refs: z.array(ArtifactRefSchema),
    created_at: TimestampSchema,
  })
  .strict();

export const TurnResourceSchema = z
  .object({
    turn_id: TurnIdSchema,
    status: TurnStatusSchema,
    started_at: TimestampSchema.optional(),
    finished_at: TimestampSchema.optional(),
    result_refs: z.array(ArtifactRefSchema),
    execution_plan: ExecutionPlanSchema.optional(),
    problem: ProblemDetailsSchema.optional(),
  })
  .strict()
  .superRefine((turn, context) => {
    if ((turn.status === 'failed' || turn.status === 'interrupted') && turn.problem === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['problem'],
        message: 'failed and interrupted turns require problem details',
      });
    }
  });

export const QuestionDraftAnswerSchema = z
  .object({
    question_id: QuestionIdSchema,
    answer: z.string().max(10_000),
  })
  .strict();

export const QuestionDraftAnswersSchema = z
  .array(QuestionDraftAnswerSchema)
  .superRefine((answers, context) => {
    const seen = new Set<string>();
    answers.forEach((answer, index) => {
      if (seen.has(answer.question_id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'question_id'],
          message: 'each question may have one draft answer',
        });
      }
      seen.add(answer.question_id);
    });
  });

export const QuestionSetResourceSchema = z
  .object({
    question_set_id: QuestionSetIdSchema,
    turn_id: TurnIdSchema,
    status: z.enum(['pending', 'answered']),
    questions: QuestionListSchema,
    draft_answers: QuestionDraftAnswersSchema,
    created_at: TimestampSchema,
  })
  .strict();

export const QuestionDraftParamsSchema = z
  .object({
    sessionId: SessionIdSchema,
    questionSetId: QuestionSetIdSchema,
  })
  .strict();

export const SkillJobResourceSchema = z
  .object({
    turn_id: TurnIdSchema,
    skill_name: z.string().min(1).max(128),
    job_id: OpaqueIdSchema,
    status: SkillJobStatusSchema,
    stage: z.string().min(1).max(256).optional(),
    progress: SkillProgressSchema.optional(),
    warnings: z.array(z.string().min(1).max(2_000)).optional(),
    result_refs: z.array(ArtifactRefSchema).optional(),
  })
  .strict();

export const UpdateQuestionDraftRequestSchema = ApiRequestBaseSchema.extend({
  draft_answers: QuestionDraftAnswersSchema,
}).strict();

export const UpdateQuestionDraftResponseSchema = ApiResponseBaseSchema.extend({
  question_set: QuestionSetResourceSchema,
}).strict();

export const SessionDetailResponseSchema = ApiResponseBaseSchema.extend({
  session: SessionResourceSchema,
  messages: z.array(MessageResourceSchema),
  turns: z.array(TurnResourceSchema),
  sources: z.array(SourceSnapshotSchema),
  artifacts: z.array(ArtifactResourceSchema),
  skill_jobs: z.array(SkillJobResourceSchema),
  pending_question_set: QuestionSetResourceSchema.optional(),
  last_event_id: EventIdSchema.optional(),
}).strict();

export const DeleteSessionRequestSchema = ApiRequestBaseSchema.extend({
  confirm_session_id: SessionIdSchema,
}).strict();

export const DeleteSessionResponseSchema = ApiResponseBaseSchema.extend({
  deleted_session_id: SessionIdSchema,
}).strict();

const SubmitUserMessageSchema = ApiRequestBaseSchema.extend({
  kind: z.literal('message'),
  content: z.string().min(1).max(100_000),
  source_refs: z.array(SourceRefSchema).max(MAX_UPLOAD_FILES),
}).strict();

const SubmitQuestionAnswersSchema = ApiRequestBaseSchema.extend({
  kind: z.literal('question_answers'),
  question_set_id: QuestionSetIdSchema,
  answers: QuestionAnswersSchema,
}).strict();

export const SubmitMessageRequestSchema = z.discriminatedUnion('kind', [
  SubmitUserMessageSchema,
  SubmitQuestionAnswersSchema,
]);

export const SubmitMessageResponseSchema = ApiResponseBaseSchema.extend({
  turn: TurnResourceSchema,
  replayed: z.boolean(),
}).strict();

export const CancelTurnRequestSchema = ApiRequestBaseSchema.extend({
  reason: z.string().min(1).max(1_000).optional(),
}).strict();

export const CancelTurnResponseSchema = ApiResponseBaseSchema.extend({
  turn: TurnResourceSchema,
  replayed: z.boolean(),
}).strict();

export const UploadBatchRequestSchema = ApiRequestBaseSchema.extend({
  files: z
    .array(z.string().meta({ format: 'binary' }))
    .min(1)
    .max(MAX_UPLOAD_FILES),
}).strict();

export const UploadBatchResponseSchema = ApiResponseBaseSchema.extend({
  sources: z.array(SourceSnapshotSchema).min(1).max(MAX_UPLOAD_FILES),
}).strict();

export const EventsQuerySchema = z
  .object({
    after_event_id: EventIdSchema.optional(),
  })
  .strict();

export const EventsHeadersSchema = z
  .object({
    'last-event-id': EventIdSchema.optional(),
  })
  .strict();

export const ArtifactsQuerySchema = z
  .object({
    turn_id: TurnIdSchema.optional(),
  })
  .strict();

export const ArtifactsResponseSchema = ApiResponseBaseSchema.extend({
  artifacts: z.array(ArtifactResourceSchema),
}).strict();

export const TurnResponseSchema = ApiResponseBaseSchema.extend({
  turn: TurnResourceSchema,
}).strict();

export const DependencyCheckSchema = z
  .object({
    name: z.string().min(1).max(128),
    status: z.enum(['ready', 'degraded', 'unavailable', 'unknown']),
    version: z.string().min(1).max(128).optional(),
    capability_summary: z.string().min(1).max(1_000).optional(),
    recovery_command: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const HealthResponseSchema = ApiResponseBaseSchema.extend({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  service_version: z.string().min(1).max(128),
  checks: z.array(DependencyCheckSchema),
}).strict();

export const DoctorResponseSchema = ApiResponseBaseSchema.extend({
  status: z.enum(['ready', 'degraded', 'unavailable']),
  generated_at: TimestampSchema,
  checks: z.array(DependencyCheckSchema),
}).strict();

export type SessionResource = z.infer<typeof SessionResourceSchema>;
export type TurnResource = z.infer<typeof TurnResourceSchema>;
export type SubmitMessageRequest = z.infer<typeof SubmitMessageRequestSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
