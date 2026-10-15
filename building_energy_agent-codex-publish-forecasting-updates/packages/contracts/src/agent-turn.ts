import { z } from 'zod';

import { ArtifactRefSchema } from './artifact.js';
import { QuestionIdSchema } from './base.js';

export const QuestionSchema = z
  .object({
    id: QuestionIdSchema,
    question: z.string().min(1).max(2_000),
    options: z.array(z.string().min(1).max(500)),
    allow_free_text: z.boolean(),
    required: z.boolean(),
  })
  .strict()
  .superRefine((question, context) => {
    if (question.options.length === 0 && !question.allow_free_text) {
      context.addIssue({
        code: 'custom',
        message: 'a question needs options or free-text input',
        path: ['options'],
      });
    }
    if (new Set(question.options).size !== question.options.length) {
      context.addIssue({
        code: 'custom',
        message: 'question options must be unique',
        path: ['options'],
      });
    }
  });

export const QuestionListSchema = z
  .array(QuestionSchema)
  .min(1)
  .superRefine((questions, context) => {
    const seen = new Set<string>();
    questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        context.addIssue({
          code: 'custom',
          message: 'question ids must be unique',
          path: [index, 'id'],
        });
      }
      seen.add(question.id);
    });
  });

export const CompletedAgentTurnEnvelopeSchema = z
  .object({
    status: z.literal('completed'),
    message: z.string().min(1).max(100_000),
    result_refs: z.array(ArtifactRefSchema),
  })
  .strict();

export const PartialAgentTurnEnvelopeSchema = z
  .object({
    status: z.literal('partial'),
    message: z.string().min(1).max(100_000),
    result_refs: z.array(ArtifactRefSchema),
  })
  .strict();

export const NeedsInputAgentTurnEnvelopeSchema = z
  .object({
    status: z.literal('needs_input'),
    message: z.string().min(1).max(100_000).optional(),
    questions: QuestionListSchema,
  })
  .strict();

export const AgentTurnEnvelopeSchema = z.discriminatedUnion('status', [
  CompletedAgentTurnEnvelopeSchema,
  PartialAgentTurnEnvelopeSchema,
  NeedsInputAgentTurnEnvelopeSchema,
]);

export const QuestionAnswerSchema = z
  .object({
    question_id: QuestionIdSchema,
    answer: z.string().min(1).max(10_000),
  })
  .strict();

export const QuestionAnswersSchema = z
  .array(QuestionAnswerSchema)
  .min(1)
  .superRefine((answers, context) => {
    const seen = new Set<string>();
    answers.forEach((answer, index) => {
      if (seen.has(answer.question_id)) {
        context.addIssue({
          code: 'custom',
          message: 'each question may be answered once',
          path: [index, 'question_id'],
        });
      }
      seen.add(answer.question_id);
    });
  });

export type Question = z.infer<typeof QuestionSchema>;
export type AgentTurnEnvelope = z.infer<typeof AgentTurnEnvelopeSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
