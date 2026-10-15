import type {
  AgentTurnEnvelope,
  ExecutionPlan,
  ReasoningLevel,
  SkillEvent,
  SseEvent,
} from '@building-energy/contracts';
import type { ThreadEvent, Usage } from '@openai/codex-sdk';

export type Clock = () => Date;

export interface ModelDefinition {
  id: string;
  displayName: string;
  reasoningLevels: ReasoningLevel[];
  defaultReasoningLevel: ReasoningLevel;
  availability: 'available' | 'unavailable' | 'probing';
  unavailableReason?: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  projectRoot: string;
  runtimeRoot: string;
  databasePath: string;
  modelsPath: string;
  serviceVersion: string;
  codexPath?: string;
  codexProbeModels: boolean;
  cancelTimeoutMs: number;
  heartbeatMs: number;
  slowConsumerTimeoutMs: number;
  /**
   * The watchdog only observes an otherwise live adapter call.  These fields
   * are optional so existing test/application fixtures remain source
   * compatible; the runtime supplies conservative defaults when omitted.
   */
  watchdogIntervalMs?: number;
  watchdogWarningMs?: number;
  watchdogTerminationMs?: number;
  watchdogStallMs?: number;
  logs: {
    maxBytes: number;
    backups: number;
  };
  publicRead: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    allowedMediaTypes: string[];
  };
}

export interface CodexTurnRequest {
  sessionId: string;
  turnId: string;
  threadId: string | null;
  workspacePath: string;
  model: string;
  reasoningLevel: ReasoningLevel;
  content: string;
  sources: Array<{ sourceRef: string; relativePath: string; originalName: string }>;
  /** Compact, server-verified state; never a full Skill/report transcript. */
  runtimeContext?: string;
  signal: AbortSignal;
  onThreadStarted: (threadId: string) => Promise<void>;
  onEvent: (event: ThreadEvent) => Promise<void>;
}

export interface CodexTurnResult {
  threadId: string;
  envelope: AgentTurnEnvelope;
  usage?: Usage;
}

export interface CodexAdapter {
  runTurn(request: CodexTurnRequest): Promise<CodexTurnResult>;
  diagnose(): Promise<
    Array<{
      name: string;
      status: 'ready' | 'degraded' | 'unavailable' | 'unknown';
      version?: string;
      capability_summary?: string;
      recovery_command?: string;
    }>
  >;
}

export interface ActiveExecution {
  turnId: string;
  controller: AbortController;
  done: Promise<void>;
}

export type PersistableEvent = Omit<SseEvent, 'event_id' | 'occurred_at'>;

export interface ProjectedSdkEvent {
  events: PersistableEvent[];
  finalMessage?: string;
  skillEvents: SkillEvent[];
  executionPlans: ExecutionPlan[];
}
