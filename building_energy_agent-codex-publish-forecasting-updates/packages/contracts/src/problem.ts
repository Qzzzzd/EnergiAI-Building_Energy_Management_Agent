import { z, type ZodType } from 'zod';

import { ApiPathSchema, CorrelationIdSchema } from './base.js';
import { classifyProtocolVersion, getSupportedVersion, type ProtocolName } from './versions.js';

export const ProblemCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNSUPPORTED_PROTOCOL_VERSION',
  'INCOMPATIBLE_PROTOCOL_VERSION',
  'RESOURCE_NOT_FOUND',
  'RESOURCE_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'SESSION_BUSY',
  'SESSION_STATE_INVALID',
  'MODEL_NOT_ALLOWED',
  'MODEL_UNAVAILABLE',
  'MODEL_LOCKED',
  'UPLOAD_LIMIT_EXCEEDED',
  'UNSUPPORTED_MEDIA_TYPE',
  'SOURCE_REFERENCE_INVALID',
  'ARTIFACT_REFERENCE_INVALID',
  'ARTIFACT_INTEGRITY_FAILED',
  'SKILL_PROTOCOL_ERROR',
  'SKILL_ENV_NOT_READY',
  'DEPENDENCY_MISSING',
  'UNAUTHENTICATED',
  'CANCEL_FAILED',
  'TURN_FAILED',
  'TURN_INTERRUPTED',
  'INTERNAL_ERROR',
]);

export const InvalidParameterSchema = z
  .object({
    name: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const RecoveryActionCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const RecoveryActionSchema = z
  .object({
    code: RecoveryActionCodeSchema,
    label: z.string().min(1).max(200),
    href: ApiPathSchema.optional(),
  })
  .strict();

export const ProblemDetailsSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1).max(2_000),
    instance: ApiPathSchema.optional(),
    code: ProblemCodeSchema,
    correlation_id: CorrelationIdSchema,
    invalid_params: z.array(InvalidParameterSchema).optional(),
    recovery_actions: z.array(RecoveryActionSchema).optional(),
  })
  .strict();

export type ProblemCode = z.infer<typeof ProblemCodeSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export function validationProblem(
  error: z.ZodError,
  correlationId: string,
  instance?: string,
): ProblemDetails {
  return ProblemDetailsSchema.parse({
    type: 'https://building-energy.local/problems/validation-error',
    title: '请求验证失败',
    status: 400,
    detail: '请求不符合公共契约。',
    ...(instance === undefined ? {} : { instance }),
    code: 'VALIDATION_ERROR',
    correlation_id: correlationId,
    invalid_params: error.issues.map((issue) => ({
      name: issue.path.length === 0 ? '$' : issue.path.join('.'),
      reason: issue.code,
    })),
  });
}

export function protocolVersionProblem(
  protocol: ProtocolName,
  receivedVersion: unknown,
  correlationId: string,
  instance?: string,
): ProblemDetails {
  const compatibility = classifyProtocolVersion(protocol, receivedVersion);
  const incompatible = compatibility === 'incompatible';
  return ProblemDetailsSchema.parse({
    type: incompatible
      ? 'https://building-energy.local/problems/incompatible-protocol-version'
      : 'https://building-energy.local/problems/unsupported-protocol-version',
    title: incompatible ? '协议版本不兼容' : '不支持的协议版本',
    status: 400,
    detail: `服务仅支持 ${protocol} 协议 ${getSupportedVersion(protocol)}。`,
    ...(instance === undefined ? {} : { instance }),
    code: incompatible ? 'INCOMPATIBLE_PROTOCOL_VERSION' : 'UNSUPPORTED_PROTOCOL_VERSION',
    correlation_id: correlationId,
    recovery_actions: [{ code: 'USE_SUPPORTED_VERSION', label: '使用服务声明的协议版本' }],
  });
}

export function skillProtocolProblem(
  correlationId: string,
  invalidParams?: z.infer<typeof InvalidParameterSchema>[],
): ProblemDetails {
  return ProblemDetailsSchema.parse({
    type: 'https://building-energy.local/problems/skill-protocol-error',
    title: 'Skill 协议错误',
    status: 422,
    detail: 'Skill 输出不是合法的 BE_SKILL_EVENT。',
    code: 'SKILL_PROTOCOL_ERROR',
    correlation_id: correlationId,
    ...(invalidParams === undefined ? {} : { invalid_params: invalidParams }),
    recovery_actions: [{ code: 'CHECK_SKILL_PROTOCOL', label: '检查 Skill 版本与机器可读输出' }],
  });
}

export type ContractParseResult<T> =
  { success: true; data: T } | { success: false; problem: ProblemDetails };

export function parseContract<T>(
  schema: ZodType<T>,
  input: unknown,
  options: { correlationId: string; instance?: string },
): ContractParseResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return {
    success: false,
    problem: validationProblem(parsed.error, options.correlationId, options.instance),
  };
}

export function parseVersionedContract<T>(
  schema: ZodType<T>,
  input: unknown,
  options: {
    protocol: ProtocolName;
    versionField: 'api_version' | 'protocol_version' | 'schema_version';
    correlationId: string;
    instance?: string;
  },
): ContractParseResult<T> {
  const record =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const receivedVersion = record[options.versionField];
  if (classifyProtocolVersion(options.protocol, receivedVersion) !== 'compatible') {
    return {
      success: false,
      problem: protocolVersionProblem(
        options.protocol,
        receivedVersion,
        options.correlationId,
        options.instance,
      ),
    };
  }
  return parseContract(schema, input, options);
}
