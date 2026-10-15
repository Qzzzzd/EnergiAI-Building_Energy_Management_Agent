import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const generatedPath = (name: string) =>
  fileURLToPath(new URL(`../generated/${name}`, import.meta.url));

describe('generated public contracts', () => {
  it('contains all public REST paths and non-REST protocol components', () => {
    const document = JSON.parse(readFileSync(generatedPath('openapi.json'), 'utf8')) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/health',
        '/api/v1/doctor',
        '/api/v1/models',
        '/api/v1/sessions',
        '/api/v1/sessions/{sessionId}',
        '/api/v1/sessions/{sessionId}/question-sets/{questionSetId}/draft',
        '/api/v1/sessions/{sessionId}/uploads',
        '/api/v1/sessions/{sessionId}/messages',
        '/api/v1/sessions/{sessionId}/cancel',
        '/api/v1/sessions/{sessionId}/events',
        '/api/v1/sessions/{sessionId}/turns/{turnId}',
        '/api/v1/sessions/{sessionId}/artifacts',
        '/api/v1/artifacts/{artifactId}/content',
      ]),
    );
    expect(
      (document.paths['/api/v1/sessions/{sessionId}'] as {
        patch?: { operationId?: string };
      }).patch?.operationId,
    ).toBe('updateSession');
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining([
        'AgentTurnEnvelope',
        'SseEvent',
        'SkillLifecycleCommand',
        'SkillEvent',
        'PersistedSkillJobState',
        'ArtifactManifest',
        'ProblemDetails',
      ]),
    );
  });

  it('emits generated frontend declarations rather than a handwritten contract', () => {
    const types = readFileSync(generatedPath('api-types.ts'), 'utf8');
    expect(types.startsWith('// Generated from Zod via OpenAPI. Do not edit by hand.')).toBe(true);
    expect(types).toContain('export interface paths');
    expect(types).toContain('SseEvent:');
    expect(types).toContain('ArtifactManifest:');
    expect(types).toContain('UpdateSessionRequest:');
  });
});
