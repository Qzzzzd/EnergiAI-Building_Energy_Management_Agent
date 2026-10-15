import { z } from 'zod';

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_UPLOAD_BATCH_BYTES = 200 * 1024 * 1024;

export const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be an opaque identifier');

export const SessionIdSchema = OpaqueIdSchema;
export const TurnIdSchema = OpaqueIdSchema;
export const MessageIdSchema = OpaqueIdSchema;
export const QuestionIdSchema = OpaqueIdSchema;
export const QuestionSetIdSchema = OpaqueIdSchema;
export const ArtifactIdSchema = OpaqueIdSchema;
export const SourceRefSchema = OpaqueIdSchema;
export const JobIdSchema = OpaqueIdSchema;
export const EventIdSchema = z.string().regex(/^[1-9]\d*$/, 'must be a positive decimal cursor');
export const IdempotencyKeySchema = z.string().min(1).max(128);
export const CorrelationIdSchema = OpaqueIdSchema;

export const TimestampSchema = z.string().datetime({ offset: true });
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');
export const MediaTypeSchema = z
  .string()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]*)?$/i);

export const ApiPathSchema = z.string().regex(/^\/api\/v1\/(?!\/)[^\s]*$/);

export const SafeRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => {
      if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
        return false;
      }
      if (/^[A-Za-z]:/.test(value) || value.includes('//')) {
        return false;
      }
      const segments = value.split('/');
      return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
    },
    { message: 'must be a normalized POSIX path relative to the controlled root' },
  );

// Inputs reach this boundary through JSON/JSONL decoders; values remain unknown
// so generic Skills can evolve payloads without introducing backend branches.
export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const SessionStatusSchema = z.enum(['empty', 'idle', 'running', 'needs_input', 'deleting']);

export const TurnStatusSchema = z.enum([
  'queued',
  'running',
  'needs_input',
  'completed',
  'partial',
  'failed',
  'cancelling',
  'cancelled',
  'interrupted',
]);

export const SkillJobStatusSchema = z.enum([
  'queued',
  'running',
  'needs_input',
  'succeeded',
  'partial',
  'failed',
  'cancelling',
  'cancelled',
  'interrupted',
]);

export const ArtifactStatusSchema = z.enum(['succeeded', 'partial']);
export const ReasoningLevelSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export type TurnStatus = z.infer<typeof TurnStatusSchema>;
export type SkillJobStatus = z.infer<typeof SkillJobStatusSchema>;
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

export const TERMINAL_TURN_STATUSES = [
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies readonly TurnStatus[];

export const TERMINAL_SKILL_JOB_STATUSES = [
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
] as const satisfies readonly SkillJobStatus[];

const sessionTransitions: Readonly<Record<SessionStatus, readonly SessionStatus[]>> = {
  empty: ['running', 'deleting'],
  idle: ['running', 'deleting'],
  running: ['idle', 'needs_input'],
  needs_input: ['running', 'deleting'],
  deleting: [],
};

const turnTransitions: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = {
  queued: ['running', 'failed', 'cancelled', 'interrupted'],
  running: [
    'needs_input',
    'completed',
    'partial',
    'failed',
    'cancelling',
    'cancelled',
    'interrupted',
  ],
  needs_input: ['queued'],
  cancelling: ['failed', 'cancelled', 'interrupted'],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

const skillJobTransitions: Readonly<Record<SkillJobStatus, readonly SkillJobStatus[]>> = {
  queued: ['running', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  running: [
    'needs_input',
    'succeeded',
    'partial',
    'failed',
    'cancelling',
    'cancelled',
    'interrupted',
  ],
  needs_input: ['running', 'failed', 'cancelling', 'cancelled', 'interrupted'],
  cancelling: ['failed', 'cancelled', 'interrupted'],
  succeeded: [],
  partial: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

function permitsTransition<T extends string>(
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): boolean {
  return from === to || transitions[from].includes(to);
}

export function isSessionStatusTransition(from: SessionStatus, to: SessionStatus): boolean {
  return permitsTransition(sessionTransitions, from, to);
}

export function isTurnStatusTransition(from: TurnStatus, to: TurnStatus): boolean {
  return permitsTransition(turnTransitions, from, to);
}

export function isSkillJobStatusTransition(from: SkillJobStatus, to: SkillJobStatus): boolean {
  return permitsTransition(skillJobTransitions, from, to);
}
