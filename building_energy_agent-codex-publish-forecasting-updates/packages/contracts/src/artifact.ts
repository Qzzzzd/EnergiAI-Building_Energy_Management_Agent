import { z } from 'zod';

import {
  ApiPathSchema,
  ArtifactIdSchema,
  ArtifactStatusSchema,
  JobIdSchema,
  JsonObjectSchema,
  MediaTypeSchema,
  SafeRelativePathSchema,
  Sha256Schema,
  SourceRefSchema,
} from './base.js';
import { ArtifactSchemaVersionSchema } from './versions.js';

export const ArtifactProducerSchema = z
  .object({
    skill_name: z.string().min(1).max(128),
    job_id: JobIdSchema,
  })
  .strict();

export const ArtifactManifestFileSchema = z
  .object({
    relative_path: SafeRelativePathSchema,
    media_type: MediaTypeSchema,
    size_bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    role: z.string().min(1).max(128),
  })
  .strict();

export const ArtifactManifestSchema = z
  .object({
    schema_version: ArtifactSchemaVersionSchema,
    artifact_id: ArtifactIdSchema,
    artifact_type: z.string().min(1).max(128),
    producer: ArtifactProducerSchema,
    source_ids: z.array(SourceRefSchema),
    status: ArtifactStatusSchema,
    files: z.array(ArtifactManifestFileSchema).min(1),
    summary: JsonObjectSchema,
    warnings: z.array(z.string().min(1).max(2_000)),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map((file) => file.relative_path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: 'artifact file paths must be unique',
      });
    }
    if (new Set(manifest.source_ids).size !== manifest.source_ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['source_ids'],
        message: 'artifact source ids must be unique',
      });
    }
  });

export const ArtifactRefSchema = z
  .object({
    artifact_id: ArtifactIdSchema,
    artifact_type: z.string().min(1).max(128),
    status: ArtifactStatusSchema,
    manifest_url: ApiPathSchema,
  })
  .strict();

export const ArtifactFileResourceSchema = z
  .object({
    name: z.string().min(1).max(255),
    media_type: MediaTypeSchema,
    size_bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    role: z.string().min(1).max(128),
    content_url: ApiPathSchema,
  })
  .strict();

export const ArtifactResourceSchema = z
  .object({
    schema_version: ArtifactSchemaVersionSchema,
    artifact_id: ArtifactIdSchema,
    artifact_type: z.string().min(1).max(128),
    producer: ArtifactProducerSchema,
    source_ids: z.array(SourceRefSchema),
    status: ArtifactStatusSchema,
    files: z.array(ArtifactFileResourceSchema).min(1),
    summary: JsonObjectSchema,
    warnings: z.array(z.string().min(1).max(2_000)),
  })
  .strict();

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactResource = z.infer<typeof ArtifactResourceSchema>;
