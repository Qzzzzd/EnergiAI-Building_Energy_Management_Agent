import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AgentTurnEnvelopeSchema, type AgentTurnEnvelope } from '@building-energy/contracts';
import { Codex, type ModelReasoningEffort, type ThreadEvent, type Usage } from '@openai/codex-sdk';

import { redactText } from './redaction.js';
import type { CodexAdapter, CodexTurnRequest, CodexTurnResult } from './types.js';

const execFileAsync = promisify(execFile);
const SDK_REASONING = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const PROXY_ENVIRONMENT_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

type AdapterCheck = {
  name: string;
  status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
  version?: string;
  capability_summary?: string;
  recovery_command?: string;
};

export const AGENT_TURN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['completed', 'partial', 'needs_input'] },
    message: { type: 'string' },
    result_refs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artifact_id: { type: 'string' },
          artifact_type: { type: 'string' },
          status: { enum: ['succeeded', 'partial'] },
          manifest_url: { type: 'string' },
        },
        required: ['artifact_id', 'artifact_type', 'status', 'manifest_url'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          allow_free_text: { type: 'boolean' },
          required: { type: 'boolean' },
        },
        required: ['id', 'question', 'options', 'allow_free_text', 'required'],
        additionalProperties: false,
      },
    },
  },
  required: ['status', 'message', 'result_refs', 'questions'],
  additionalProperties: false,
} as const;

export class CodexAdapterError extends Error {
  constructor(
    readonly code:
      'UNAUTHENTICATED' | 'MODEL_UNAVAILABLE' | 'TURN_FAILED' | 'INVALID_OUTPUT' | 'ABORTED',
    message: string,
  ) {
    super(message);
  }
}

export class RealCodexAdapter implements CodexAdapter {
  private readonly codex: Codex;
  private readonly executable: string;
  private readonly realExecutable: string;
  private readonly environment: Record<string, string>;
  private readonly apiKey: string | undefined;

  constructor(options: {
    projectRoot: string;
    codexPath?: string;
    baseUrl?: string;
    apiKey?: string;
  }) {
    this.executable = path.join(options.projectRoot, 'apps/server/bin/codex-process-group.mjs');
    this.realExecutable =
      options.codexPath ?? path.join(options.projectRoot, 'apps/server/node_modules/.bin/codex');
    const environment: Record<string, string> = {};
    for (const key of [
      'HOME',
      'PATH',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'CODEX_HOME',
      'BE_CODEX_APPARMOR_PROFILE',
      ...PROXY_ENVIRONMENT_KEYS,
    ]) {
      const value = process.env[key];
      if (value) environment[key] = value;
    }
    environment.PATH = `${path.join(options.projectRoot, 'apps/server/bin')}:${path.join(options.projectRoot, 'scripts')}:${environment.PATH ?? '/usr/bin:/bin'}`;
    environment.BE_CODEX_REAL_BIN = this.realExecutable;
    this.environment = environment;
    this.apiKey = options.apiKey;
    this.codex = new Codex({
      codexPathOverride: this.executable,
      env: environment,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      config: {
        shell_environment_policy: {
          exclude: [...PROXY_ENVIRONMENT_KEYS],
        },
      },
    });
  }

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    if (!SDK_REASONING.has(request.reasoningLevel)) {
      throw new CodexAdapterError('MODEL_UNAVAILABLE', '当前 SDK 不支持该 reasoning level。');
    }
    const threadOptions = {
      model: request.model,
      modelReasoningEffort: request.reasoningLevel as ModelReasoningEffort,
      workingDirectory: request.workspacePath,
      sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'never' as const,
      networkAccessEnabled: false,
      webSearchMode: 'live' as const,
      skipGitRepoCheck: true,
    };
    const thread = request.threadId
      ? this.codex.resumeThread(request.threadId, threadOptions)
      : this.codex.startThread(threadOptions);
    const streamed = await thread.runStreamed(buildTurnPrompt(request), {
      outputSchema: AGENT_TURN_OUTPUT_SCHEMA,
      signal: request.signal,
    });
    let finalText: string | undefined;
    let usage: Usage | undefined;
    try {
      for await (const event of streamed.events) {
        if (event.type === 'thread.started') await request.onThreadStarted(event.thread_id);
        if (
          (event.type === 'item.updated' || event.type === 'item.completed') &&
          event.item.type === 'agent_message'
        ) {
          finalText = event.item.text;
        }
        if (event.type === 'turn.completed') usage = event.usage;
        if (event.type === 'turn.failed') {
          throw classifySdkError(event.error.message);
        }
        if (event.type === 'error') throw classifySdkError(event.message);
        await request.onEvent(event);
      }
    } catch (error) {
      if (request.signal.aborted || (error as NodeJS.ErrnoException).name === 'AbortError') {
        throw new CodexAdapterError('ABORTED', 'Codex turn 已中止。');
      }
      throw error;
    }
    const threadId = thread.id ?? request.threadId;
    if (!threadId) throw new CodexAdapterError('TURN_FAILED', 'Codex 未返回 thread ID。');
    if (!finalText) throw new CodexAdapterError('INVALID_OUTPUT', 'Codex 未返回结构化终态。');
    let envelope: AgentTurnEnvelope;
    try {
      envelope = parseAgentTurnOutput(JSON.parse(finalText));
    } catch {
      throw new CodexAdapterError('INVALID_OUTPUT', 'Codex 终态不符合 AgentTurnEnvelope。');
    }
    return { threadId, envelope, ...(usage ? { usage } : {}) };
  }

  async diagnose(): Promise<AdapterCheck[]> {
    try {
      await access(this.executable);
      const version = await execFileAsync(this.realExecutable, ['--version'], {
        timeout: 5_000,
        maxBuffer: 4_096,
      });
      let loginStatus: 'ready' | 'unavailable' | 'unknown' = 'unknown';
      try {
        await execFileAsync(this.realExecutable, ['login', 'status'], {
          env: this.apiKey ? { ...this.environment, CODEX_API_KEY: this.apiKey } : this.environment,
          timeout: 5_000,
          maxBuffer: 4_096,
        });
        loginStatus = 'ready';
      } catch {
        loginStatus = 'unavailable';
      }
      return [
        {
          name: 'codex-cli',
          status: 'ready',
          version: redactText(version.stdout.trim(), 128, 1),
          capability_summary: 'TypeScript SDK 0.147.0；workspace-write；AbortSignal；结构化输出',
        },
        {
          name: 'codex-login',
          status: loginStatus,
          ...(loginStatus === 'unavailable'
            ? { recovery_command: 'codex login', capability_summary: '主机 Codex 身份不可用' }
            : {
                capability_summary: this.apiKey
                  ? '使用独立 Codex API Key；不读取凭据内容'
                  : '复用主机 Codex 身份；不读取凭据内容',
              }),
        },
        await diagnoseCodexSandbox(),
      ];
    } catch {
      return [
        {
          name: 'codex-cli',
          status: 'unavailable',
          capability_summary: 'Codex CLI 不可执行',
          recovery_command: 'pnpm install',
        },
      ];
    }
  }
}

export async function diagnoseCodexSandbox(options?: {
  platform?: NodeJS.Platform;
  profile?: string;
  readRestriction?: () => Promise<string>;
  probeProfile?: (profile: string) => Promise<void>;
}): Promise<AdapterCheck> {
  const platform = options?.platform ?? process.platform;
  if (platform !== 'linux') {
    return {
      name: 'codex-sandbox',
      status: 'ready',
      capability_summary: '非 Linux 主机；不需要 AppArmor userns 兼容配置',
    };
  }
  const readRestriction =
    options?.readRestriction ??
    (() => readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8'));
  let restriction: string;
  try {
    restriction = (await readRestriction()).trim();
  } catch {
    return {
      name: 'codex-sandbox',
      status: 'unknown',
      capability_summary: '无法读取 Linux AppArmor userns 限制；需运行真实沙箱 canary',
    };
  }
  if (restriction !== '1') {
    return {
      name: 'codex-sandbox',
      status: 'ready',
      capability_summary: 'Linux unprivileged userns 未被 AppArmor 限制',
    };
  }
  const profile = options?.profile ?? process.env.BE_CODEX_APPARMOR_PROFILE;
  if (!profile) {
    return {
      name: 'codex-sandbox',
      status: 'unavailable',
      capability_summary: 'AppArmor 限制 unprivileged userns，Codex workspace-write 沙箱不可启动',
      recovery_command: 'BE_CODEX_APPARMOR_PROFILE=<loaded-userns-profile> scripts/start',
    };
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(profile)) {
    return {
      name: 'codex-sandbox',
      status: 'unavailable',
      capability_summary: 'BE_CODEX_APPARMOR_PROFILE 名称无效',
      recovery_command: '设置已加载且允许 userns 的 AppArmor profile 名称',
    };
  }
  const probeProfile =
    options?.probeProfile ??
    (async (profileName: string) => {
      await execFileAsync(
        '/usr/bin/aa-exec',
        ['-p', profileName, '--', 'unshare', '-Urn', 'true'],
        {
          timeout: 5_000,
          maxBuffer: 4_096,
        },
      );
    });
  try {
    await probeProfile(profile);
    return {
      name: 'codex-sandbox',
      status: 'ready',
      capability_summary: 'AppArmor profile 已通过 userns/network namespace canary',
    };
  } catch {
    return {
      name: 'codex-sandbox',
      status: 'unavailable',
      capability_summary: '配置的 AppArmor profile 未通过 userns/network namespace canary',
      recovery_command: '加载允许 userns 的 profile 后重新运行 scripts/doctor',
    };
  }
}

export function parseAgentTurnOutput(value: unknown): AgentTurnEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return AgentTurnEnvelopeSchema.parse(value);
  }
  const raw = value as Record<string, unknown>;
  if (raw.status === 'needs_input') {
    return AgentTurnEnvelopeSchema.parse({
      status: raw.status,
      ...(typeof raw.message === 'string' && raw.message.length > 0
        ? { message: raw.message }
        : {}),
      questions: raw.questions,
    });
  }
  return AgentTurnEnvelopeSchema.parse({
    status: raw.status,
    message: raw.message,
    result_refs: raw.result_refs,
  });
}

export function buildTurnPrompt(request: CodexTurnRequest): string {
  const sourceLines = request.sources.length
    ? request.sources
        .map(
          (source) =>
            `- source_ref=${source.sourceRef}; file=${source.relativePath}; name=${JSON.stringify(source.originalName)}`,
        )
        .join('\n')
    : '- none';
  return [
    'PRODUCT TURN CONTEXT (server generated)',
    `session_id=${request.sessionId}`,
    `turn_id=${request.turnId}`,
    'Uploaded sources are immutable read-only snapshots. Use only these server-provided relative references:',
    sourceLines,
    'Never use an absolute path, another session, credentials, external writes, or dependency installation.',
    'For every computing Skill, use the foreground `skill-run` command documented by that Skill. Never invoke `skillctl start` directly, detach a worker, or keep an interactive shell alive.',
    'The current working directory is an isolated session workspace. The managed `skill-run` executable is intentionally provided on PATH by the server project even though its resolved path is outside the current directory; that is not a missing dependency. Do not use the absence of `.agents/skills` under the session workspace, a relative SKILL.md lookup, or an absolute-path restriction as a reason to stop. Invoke `skill-run` directly with `--workspace-root .`; its wrapper resolves the installed Skill while keeping request, job, and Artifact files in this session workspace.',
    'Use these compact request contracts instead of rereading SKILL.md: parsing uses {"sources":[{"relative_path":"<source relativePath>","source_ref":"<source_ref>","sha256":"<sha256>"}],"strict_mode":false}; processing uses {"source_bundle_id":"<verified DatasetBundle artifact_id or native dataset_bundle_id>","target":{"point_id":"<selected point>"},"prediction_spec":{"forecast_horizon":"24h"},"feature_spec":{"preset":"default"},"data_scope":{"local_timezone":"Asia/Shanghai","processing_mode":"backtest"},"split_spec":{"anchor_time":"00:00"}}; quality uses {"source_bundle_id":"<verified DatasetBundle artifact_id or native dataset_bundle_id>","assessment_context":{"task_type":"load_forecasting","target_point_id":"<selected point>"}}; historical forecasting uses {"processing_bundle_id":"<verified ProcessingBundle artifact_id or native processing_bundle_id>","forecast_spec":{"mode":"backtest"}}; future forecasting requires a separate future-mode ProcessingBundle request with data_scope.processing_mode="future", then uses {"model_bundle_id":"<verified ModelBundle artifact_id or native model_bundle_id>","processing_bundle_id":"<verified future ProcessingBundle artifact_id or native processing_bundle_id>","forecast_spec":{"mode":"future"},"forecast_start":"<ISO timestamp>","forecast_end":"<ISO timestamp>"}; report generation uses {"report_type":"integrated | quality | forecast-evaluation | forecast-future","source_artifact_ids":{"quality":"<verified QualityAssessmentBundle artifact_id>","processing":"<verified ProcessingBundle artifact_id>","evaluation":"<verified EvaluationBundle artifact_id>","forecast":"<verified ForecastBundle artifact_id>"}}. report_type is mandatory; source_artifact_ids must be an object keyed by these exact roles, never an array, and an integrated report requires quality plus evaluation and/or forecast. Do not include ModelBundle as a report source or infer report_type from an artifact list. Replace placeholders only with values from the source list, verified runtime index, or structured Skill inputs. The managed processing adapter resolves a verified public DatasetBundle artifact to its native bundle ID.',
    'After parsing succeeds, use the verified DatasetBundle summary.point_catalog to select the target point_id for every quality or forecasting request. Prefer a continuous point whose original column name, name, or description semantically indicates load, power, electricity, energy, or cooling; do not require a specific unit, and do not use a fixed point label or whitelist. Exclude weather and state variables unless the user explicitly requests them. Use the same selected point_id for quality and processing. Select automatically only when one candidate is high confidence; when candidates are ambiguous or absent, relay the Skill needs_input options and never invent a point_id. Include the selected point and the evidence-based reason in the final business summary.',
    'Write each request JSON only in the current session workspace, run the foreground command with the exact session_id and turn_id, and relay actual BE_SKILL_EVENT/required_inputs results. A nonzero DEPENDENCY_MISSING from `skill-run` is a real environment error; never replace it with a fabricated result.',
    'When this request requires computing Skills and the runtime index has execution_plan=null, select the required Skills and immediately declare the selected plan on stdout as the first shell command after that selection, before reading Skill files or references, inspecting the workspace, validating sources, writing request files, or emitting another progress message. The declaration is exactly one line beginning `BE_EXECUTION_PLAN ` followed by JSON: {"plan_id":"...","title":"...","nodes":[{"id":"...","title":"...","skill_name":"...","depends_on":[],"parallel_group":"..."}]}. Omit optional title or parallel_group when not needed. Include every Skill node you will actually run, use node ids for dependencies, and use the same parallel_group value for nodes that may run together. `skill_name` is always the exact ASCII project directory/command ID—not a Chinese display label. The available business Skill IDs are `building-energy-data-parsing`, `building-energy-data-processing`, `building-energy-data-quality`, `building-energy-load-forecasting`, and `building-energy-report-generation`; if explicitly requested, `building-energy-dynamic-proof` is also valid. For an explicit load-forecasting request, declare the real downstream `building-energy-load-forecasting` node from the first plan even when the target point or processing output is not available yet; make it depend on the processing node and leave it pending until its required input is resolved. For a combined quality and forecasting request, declare both downstream branches up front. Do not omit a requested downstream node merely because an upstream Skill may ask for input. Do not derive this declaration from a natural-language todo list, and do not declare a Skill the user did not request. For a request that does not require a computing Skill, do not emit a plan.',
    'Execution plan validation is strict: every node must contain id, title, skill_name, and depends_on. A root node with no prerequisites must explicitly use depends_on: []; never omit the field or use null. Before emitting the plan, verify that every dependency names a declared node and every node contains all required fields.',
    'The server validates, stores, and forwards this typed plan; it does not infer or repair nodes, dependencies, or parallel groups. Emit the plan before the first `skill.started` line and never emit it twice for one turn.',
    'If the runtime index contains a non-null execution_plan, this is a structured-input continuation of that same Turn. Do not emit another `BE_EXECUTION_PLAN`, do not create a resume task, and do not repeat completed nodes. Continue unresolved plan nodes or resume the listed Job on this Turn. When parsing has produced a verified DatasetBundle and the processing node is unresolved, the next action is to run or resume the real `building-energy-data-processing` Skill with the verified bundle reference; omit `target` only when it is genuinely unresolved so the Skill can return its recognized candidate options. Do not invent `input.required` yourself. A `needs_input` response is valid only when it relays the current Skill actual `BE_SKILL_EVENT` required_inputs; never replace recoverable candidates with an empty free-text question.',
    'The server-provided runtime index below is the authoritative compact view of verified artifacts and Skill jobs. Reuse terminal job IDs and result refs when allowed; query only the specific content URL needed for the next step. Do not reread the same SKILL.md, manifest, summary, or full report when the index already answers the question, and never treat an unregistered workspace file as an Artifact.',
    'VERIFIED RUNTIME INDEX (server generated; compact metadata only)',
    request.runtimeContext ?? '{"verified_artifacts":[],"skill_jobs":[],"allowed_next_steps":[]}',
    'Direct shell network is disabled. Public reads may use Web Search or building-energy-public-fetch only.',
    'For completed or partial work, make the final message a business-facing summary of 3-6 short sentences or bullets. Include only verified facts: what was completed, target and data time range/granularity when available, model or evaluation results with key metrics and coverage, any warnings or partial limitations, and the next useful action. Do not merely say completed, repeat raw internal IDs, or invent missing fields.',
    'Return exactly one object matching the supplied output schema. For completed/partial set questions=[]; for needs_input set result_refs=[] and include every currently independent blocking question.',
    'USER MESSAGE (untrusted content follows)',
    request.content,
  ].join('\n\n');
}

export function classifySdkError(message: string): CodexAdapterError {
  const safe = redactText(message, 1_000, 10);
  if (/login|auth|unauthorized|credential/i.test(message)) {
    return new CodexAdapterError('UNAUTHENTICATED', safe);
  }
  if (/model.*(?:not found|unavailable|unsupported)/i.test(message)) {
    return new CodexAdapterError('MODEL_UNAVAILABLE', safe);
  }
  if (/(?:usage limit|quota exceeded|purchase more credits|rate limit)/i.test(message)) {
    return new CodexAdapterError('MODEL_UNAVAILABLE', safe);
  }
  return new CodexAdapterError('TURN_FAILED', safe);
}

export class FakeCodexAdapter implements CodexAdapter {
  readonly requests: CodexTurnRequest[] = [];
  private readonly scripts: Array<{
    threadId: string;
    events: ThreadEvent[];
    envelope: AgentTurnEnvelope;
    delayMs?: number;
  }> = [];

  enqueue(script: {
    threadId?: string;
    events?: ThreadEvent[];
    envelope: AgentTurnEnvelope;
    delayMs?: number;
  }): void {
    this.scripts.push({
      threadId: script.threadId ?? `fake-thread-${this.scripts.length + 1}`,
      events: script.events ?? [],
      envelope: script.envelope,
      ...(script.delayMs ? { delayMs: script.delayMs } : {}),
    });
  }

  async runTurn(request: CodexTurnRequest): Promise<CodexTurnResult> {
    this.requests.push(request);
    const script = this.scripts.shift();
    if (!script) throw new Error('fake Codex script queue is empty');
    await request.onThreadStarted(script.threadId);
    for (const event of script.events) {
      await abortableDelay(script.delayMs ?? 0, request.signal);
      await request.onEvent(event);
    }
    await abortableDelay(script.delayMs ?? 0, request.signal);
    return { threadId: script.threadId, envelope: script.envelope };
  }

  async diagnose() {
    return [
      {
        name: 'codex-cli',
        status: 'ready' as const,
        version: 'fake-0.147.0',
        capability_summary: 'deterministic fake adapter',
      },
    ];
  }
}

async function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new CodexAdapterError('ABORTED', 'fake turn aborted');
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new CodexAdapterError('ABORTED', 'fake turn aborted'));
      },
      { once: true },
    );
  });
}

export type SdkThreadEvent = ThreadEvent;
