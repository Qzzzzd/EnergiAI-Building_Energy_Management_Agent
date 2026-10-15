import { z } from 'zod';

export const PUBLIC_API_VERSION = '1.0' as const;
export const SSE_PROTOCOL_VERSION = '1.0' as const;
export const SKILL_PROTOCOL_VERSION = '1.0' as const;
export const ARTIFACT_SCHEMA_VERSION = '1.0' as const;

export const PublicApiVersionSchema = z.literal(PUBLIC_API_VERSION);
export const SseProtocolVersionSchema = z.literal(SSE_PROTOCOL_VERSION);
export const SkillProtocolVersionSchema = z.literal(SKILL_PROTOCOL_VERSION);
export const ArtifactSchemaVersionSchema = z.literal(ARTIFACT_SCHEMA_VERSION);

export type ProtocolName = 'api' | 'sse' | 'skill' | 'artifact';

const supportedVersions: Readonly<Record<ProtocolName, string>> = {
  api: PUBLIC_API_VERSION,
  sse: SSE_PROTOCOL_VERSION,
  skill: SKILL_PROTOCOL_VERSION,
  artifact: ARTIFACT_SCHEMA_VERSION,
};

export type VersionCompatibility = 'compatible' | 'unsupported' | 'incompatible';

export function getSupportedVersion(protocol: ProtocolName): string {
  return supportedVersions[protocol];
}

export function classifyProtocolVersion(
  protocol: ProtocolName,
  receivedVersion: unknown,
): VersionCompatibility {
  const supported = supportedVersions[protocol];
  if (receivedVersion === supported) {
    return 'compatible';
  }
  if (typeof receivedVersion !== 'string' || !/^\d+\.\d+$/.test(receivedVersion)) {
    return 'incompatible';
  }
  return receivedVersion.split('.', 1)[0] === supported.split('.', 1)[0]
    ? 'unsupported'
    : 'incompatible';
}
