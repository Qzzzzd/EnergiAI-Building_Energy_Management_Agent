import { z } from 'zod';

import { QuestionListSchema } from './agent-turn.js';
import { ArtifactRefSchema } from './artifact.js';
import { ExecutionPlanSchema } from './execution-plan.js';
import {
  EventIdSchema,
  JobIdSchema,
  MessageIdSchema,
  OpaqueIdSchema,
  QuestionSetIdSchema,
  ReasoningLevelSchema,
  SessionIdSchema,
  TimestampSchema,
  TurnIdSchema,
} from './base.js';
import { ProblemDetailsSchema } from './problem.js';
import { SkillProgressSchema } from './skill.js';
import { SseProtocolVersionSchema } from './versions.js';

export const PlanItemSchema = z
  .object({
    id: OpaqueIdSchema,
    step: z.string().min(1).max(2_000),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();

export const TokenUsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  })
  .strict();

export const AgentActivitySchema = z
  .object({
    activity_id: OpaqueIdSchema,
    kind: z.enum([
      'reasoning_summary',
      'command',
      'file',
      'tool',
      'web_search',
      'retry',
      'warning',
      'info',
    ]),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    summary: z.string().min(1).max(4_000),
    detail: z.string().min(1).max(8_000).optional(),
    duration_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

const SseEventBaseSchema = z.object({
  protocol_version: SseProtocolVersionSchema,
  event_id: EventIdSchema,
  session_id: SessionIdSchema,
  turn_id: TurnIdSchema,
  occurred_at: TimestampSchema,
});

export const TurnStartedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.started'),
  data: z
    .object({
      model: z.string().min(1).max(128),
      reasoning_level: ReasoningLevelSchema,
    })
    .strict(),
}).strict();

export const PlanUpdatedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('plan.updated'),
  data: z.object({ items: z.array(PlanItemSchema) }).strict(),
}).strict();

export const ExecutionPlanEventSchema = SseEventBaseSchema.extend({
  type: z.literal('execution.plan'),
  data: z.object({ plan: ExecutionPlanSchema }).strict(),
}).strict();

export const AgentActivityEventSchema = SseEventBaseSchema.extend({
  type: z.literal('agent.activity'),
  data: AgentActivitySchema,
}).strict();

export const SkillStartedSseEventSchema = SseEventBaseSchema.extend({
  type: z.literal('skill.started'),
  data: z
    .object({
      skill_name: z.string().min(1).max(128),
      job_id: JobIdSchema,
      stage: z.string().min(1).max(256),
    })
    .strict(),
}).strict();

export const SkillProgressSseEventSchema = SseEventBaseSchema.extend({
  type: z.literal('skill.progress'),
  data: z
    .object({
      skill_name: z.string().min(1).max(128),
      job_id: JobIdSchema,
      stage: z.string().min(1).max(256),
      progress: SkillProgressSchema,
      warnings: z.array(z.string().min(1).max(2_000)),
    })
    .strict(),
}).strict();

export const SkillCompletedSseEventSchema = SseEventBaseSchema.extend({
  type: z.literal('skill.completed'),
  data: z
    .object({
      skill_name: z.string().min(1).max(128),
      job_id: JobIdSchema,
      status: z.enum(['succeeded', 'partial']),
      result_refs: z.array(ArtifactRefSchema),
      warnings: z.array(z.string().min(1).max(2_000)),
    })
    .strict(),
}).strict();

export const InputRequiredEventSchema = SseEventBaseSchema.extend({
  type: z.literal('input.required'),
  data: z
    .object({
      question_set_id: QuestionSetIdSchema,
      questions: QuestionListSchema,
    })
    .strict(),
}).strict();

export const ArtifactCreatedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('artifact.created'),
  data: z
    .object({
      artifact: ArtifactRefSchema,
    })
    .strict(),
}).strict();

export const AssistantMessageEventSchema = SseEventBaseSchema.extend({
  type: z.literal('assistant.message'),
  data: z
    .object({
      message_id: MessageIdSchema,
      content: z.string().min(1).max(100_000),
      result_refs: z.array(ArtifactRefSchema),
    })
    .strict(),
}).strict();

const SuccessfulTerminalDataSchema = z
  .object({
    message: z.string().min(1).max(100_000),
    result_refs: z.array(ArtifactRefSchema),
    duration_ms: z.number().int().nonnegative(),
    usage: TokenUsageSchema.optional(),
  })
  .strict();

export const TurnCompletedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.completed'),
  data: SuccessfulTerminalDataSchema,
}).strict();

export const TurnPartialEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.partial'),
  data: SuccessfulTerminalDataSchema,
}).strict();

export const TurnFailedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.failed'),
  data: z.object({ problem: ProblemDetailsSchema }).strict(),
}).strict();

export const TurnCancelledEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.cancelled'),
  data: z.object({ reason: z.string().min(1).max(1_000).optional() }).strict(),
}).strict();

export const TurnInterruptedEventSchema = SseEventBaseSchema.extend({
  type: z.literal('turn.interrupted'),
  data: z.object({ problem: ProblemDetailsSchema }).strict(),
}).strict();

export const SseEventSchema = z.discriminatedUnion('type', [
  TurnStartedEventSchema,
  ExecutionPlanEventSchema,
  PlanUpdatedEventSchema,
  AgentActivityEventSchema,
  SkillStartedSseEventSchema,
  SkillProgressSseEventSchema,
  SkillCompletedSseEventSchema,
  InputRequiredEventSchema,
  ArtifactCreatedEventSchema,
  AssistantMessageEventSchema,
  TurnCompletedEventSchema,
  TurnPartialEventSchema,
  TurnFailedEventSchema,
  TurnCancelledEventSchema,
  TurnInterruptedEventSchema,
]);

export type SseEvent = z.infer<typeof SseEventSchema>;
