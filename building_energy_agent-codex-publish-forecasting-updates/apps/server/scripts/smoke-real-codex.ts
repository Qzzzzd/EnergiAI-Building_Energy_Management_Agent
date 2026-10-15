import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReasoningLevel } from '@building-energy/contracts';

import { CodexAdapterError, RealCodexAdapter } from '../src/codex-adapter.js';
import { loadModelCatalog, loadServerConfig } from '../src/config.js';
import { redactText } from '../src/redaction.js';
import type { CodexTurnRequest } from '../src/types.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const config = loadServerConfig(projectRoot);
const catalog = await loadModelCatalog(config.modelsPath);
const requestedModel = option('model') ?? catalog.defaultModel;
const model = catalog.models.find((candidate) => candidate.id === requestedModel);
if (!model) throw new Error('--model is not in the server allowlist');
const requestedReasoning = (option('reasoning') ?? model.defaultReasoningLevel) as ReasoningLevel;
if (!model.reasoningLevels.includes(requestedReasoning)) {
  throw new Error('--reasoning is not allowed for the selected model');
}

const smokeRoot = path.join(config.runtimeRoot, 'smoke');
await mkdir(smokeRoot, { recursive: true, mode: 0o700 });
const workspace = await mkdtemp(path.join(smokeRoot, 'codex-'));
const smokeSessionId = `smoke-${randomUUID()}`;
const adapter = new RealCodexAdapter({
  projectRoot,
  ...(config.codexPath ? { codexPath: config.codexPath } : {}),
});
const evidence: Record<string, unknown> = {
  generated_at: new Date().toISOString(),
  sdk_version: '0.147.0',
  cli_version: '0.147.0',
  model: requestedModel,
  reasoning: requestedReasoning,
  checks: [],
};

try {
  const first = await run(
    null,
    "Return a completed AgentTurnEnvelope with message 'smoke completed' and no result_refs. Do not use tools.",
  );
  assert(first.result.envelope.status === 'completed', 'new thread did not complete structurally');
  (evidence.checks as unknown[]).push({
    name: 'new_thread_completed',
    status: 'passed',
    events: first.eventCount,
    thread_hash: threadHash(first.result.threadId),
  });

  const resumed = await run(
    first.result.threadId,
    "Continue this same thread. Return a completed AgentTurnEnvelope with message 'smoke resumed' and no result_refs. Do not use tools.",
  );
  assert(
    resumed.result.threadId === first.result.threadId,
    'resume returned a different thread id',
  );
  assert(
    resumed.result.envelope.status === 'completed',
    'resumed thread did not complete structurally',
  );
  (evidence.checks as unknown[]).push({
    name: 'resume_same_thread',
    status: 'passed',
    events: resumed.eventCount,
  });

  const questions = await run(
    first.result.threadId,
    'Return needs_input with exactly two independent required questions. Give each one option and also allow free text. Do not use tools.',
  );
  assert(
    questions.result.envelope.status === 'needs_input',
    'needs_input envelope was not returned',
  );
  assert(
    questions.result.envelope.questions.length === 2,
    'needs_input did not contain two questions',
  );
  (evidence.checks as unknown[]).push({
    name: 'structured_multi_question',
    status: 'passed',
    question_count: 2,
  });

  const controller = new AbortController();
  const cancellation = run(
    first.result.threadId,
    'Run a shell command that waits for 30 seconds, then return completed. This request is testing cancellation.',
    controller,
  );
  const cancelTimer = setTimeout(() => controller.abort('real smoke cancellation'), 750);
  try {
    await cancellation;
    throw new Error('cancelled turn unexpectedly completed');
  } catch (error) {
    assert(
      error instanceof CodexAdapterError && error.code === 'ABORTED',
      'AbortSignal did not surface ABORTED',
    );
  } finally {
    clearTimeout(cancelTimer);
  }
  (evidence.checks as unknown[]).push({ name: 'abort_signal', status: 'passed' });

  const output = { status: 'passed', ...evidence };
  await persistEvidence(output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  const output = {
    status: 'failed',
    ...evidence,
    error: error instanceof Error ? error.name : 'UnknownError',
    error_code: error instanceof CodexAdapterError ? error.code : 'SMOKE_FAILED',
    detail: redactText(error instanceof Error ? error.message : error, 1_000, 10),
  };
  await persistEvidence(output);
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function run(threadId: string | null, content: string, providedController?: AbortController) {
  const controller = providedController ?? new AbortController();
  const timeout = providedController
    ? undefined
    : setTimeout(() => controller.abort('smoke turn timeout'), 90_000);
  let observedThreadId = threadId;
  let eventCount = 0;
  const request: CodexTurnRequest = {
    sessionId: smokeSessionId,
    turnId: `smoke-${randomUUID()}`,
    threadId,
    workspacePath: workspace,
    model: requestedModel,
    reasoningLevel: requestedReasoning,
    content,
    sources: [],
    signal: controller.signal,
    onThreadStarted: async (value) => {
      observedThreadId = value;
    },
    onEvent: async () => {
      eventCount += 1;
    },
  };
  try {
    const result = await adapter.runTurn(request);
    assert(observedThreadId === result.threadId, 'streamed and final thread IDs differ');
    return { result, eventCount };
  } catch (error) {
    if (controller.signal.reason === 'smoke turn timeout') {
      throw new Error('real Codex smoke turn exceeded 90 seconds');
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function threadHash(threadId: string): string {
  return createHash('sha256').update(threadId).digest('hex').slice(0, 16);
}

async function persistEvidence(output: Record<string, unknown>): Promise<void> {
  const evidenceRoot = path.join(smokeRoot, 'evidence');
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify(output, null, 2)}\n`;
  const timestamp = String(output.generated_at).replace(/[:.]/g, '-');
  const timestamped = path.join(evidenceRoot, `real-codex-${timestamp}.json`);
  const latest = path.join(evidenceRoot, 'real-codex-latest.json');
  const temporary = `${latest}.${process.pid}.tmp`;
  await writeFile(timestamped, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, latest);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
