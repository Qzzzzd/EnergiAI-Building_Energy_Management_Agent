import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import openapiTS, { astToString } from 'openapi-typescript';
import { format, resolveConfig } from 'prettier';

import { createOpenApiDocument } from './openapi.js';

const generatedDirectory = fileURLToPath(new URL('../generated/', import.meta.url));
const openApiPath = fileURLToPath(new URL('../generated/openapi.json', import.meta.url));
const apiTypesPath = fileURLToPath(new URL('../generated/api-types.ts', import.meta.url));
const checkOnly = process.argv.includes('--check');
const prettierConfig = (await resolveConfig(apiTypesPath)) ?? {};

const document = createOpenApiDocument();
const openApiContents = await format(JSON.stringify(document), {
  ...prettierConfig,
  parser: 'json',
});
const typeAst = await openapiTS(document as unknown as Parameters<typeof openapiTS>[0]);
const apiTypesContents = await format(
  [
    '// Generated from Zod via OpenAPI. Do not edit by hand.',
    astToString(typeAst).trimEnd(),
    '',
  ].join('\n'),
  { ...prettierConfig, parser: 'typescript' },
);

async function assertCurrent(path: string, expected: string): Promise<boolean> {
  try {
    const actual = await readFile(path, 'utf8');
    if (actual === expected) {
      return true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  process.stderr.write(`Generated contract artifact is stale: ${path}\n`);
  return false;
}

if (checkOnly) {
  const results = await Promise.all([
    assertCurrent(openApiPath, openApiContents),
    assertCurrent(apiTypesPath, apiTypesContents),
  ]);
  if (results.some((result) => !result)) {
    process.exitCode = 1;
  }
} else {
  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all([
    writeFile(openApiPath, openApiContents, 'utf8'),
    writeFile(apiTypesPath, apiTypesContents, 'utf8'),
  ]);
}
