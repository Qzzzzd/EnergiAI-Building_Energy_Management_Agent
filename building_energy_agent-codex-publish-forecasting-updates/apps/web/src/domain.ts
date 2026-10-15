export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'deleting';

export type TurnStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted';

export type SkillJobStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'interrupted';

export interface ModelOption {
  id: string;
  displayName: string;
  reasoningLevels: ReasoningLevel[];
  available: boolean;
  unavailableReason?: string;
  isDefault?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  model: string | null;
  reasoning: ReasoningLevel | null;
  modelLocked: boolean;
  archived: boolean;
  updatedAt: string;
  preview: string;
}

export interface Message {
  id: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  sourceRefs?: string[];
}

export interface Question {
  id: string;
  question: string;
  options: string[];
  allowFreeText: boolean;
  required: boolean;
  context?: string;
}

export interface QuestionSet {
  id: string;
  turnId: string;
  status: 'pending' | 'answered';
  questions: Question[];
  draft: Record<string, string>;
}

export type ActivityKind =
  | 'plan'
  | 'agent'
  | 'skill'
  | 'command'
  | 'reasoning_summary'
  | 'web_search'
  | 'artifact'
  | 'warning'
  | 'error';

export interface ActivityItem {
  id: string;
  turnId: string;
  kind: ActivityKind;
  title: string;
  summary?: string;
  status:
    | 'pending'
    | 'queued'
    | 'running'
    | 'needs_input'
    | 'completed'
    | 'partial'
    | 'failed'
    | 'cancelling'
    | 'cancelled'
    | 'interrupted';
  stage?: string;
  progress?: { completed: number; total: number; unit: string };
  startedAt?: string;
  finishedAt?: string;
  parallelGroup?: string;
  skillName?: string;
  jobId?: string;
  warnings?: string[];
  outcome?: 'succeeded' | 'partial';
  resultRefs?: ArtifactRefView[];
  model?: string;
  reasoning?: ReasoningLevel;
  tokens?: { input: number; cached?: number; output: number };
}

export interface ArtifactRefView {
  artifactId: string;
  artifactType: string;
  status: 'succeeded' | 'partial';
  manifestUrl: string;
}

export interface SkillJobView {
  turnId: string;
  skillName: string;
  jobId: string;
  status: SkillJobStatus;
  stage?: string;
  progress?: { completed: number; total: number; unit: string };
  warnings: string[];
  resultRefs?: ArtifactRefView[];
}

export interface ExecutionPlanNodeView {
  id: string;
  title: string;
  skillName: string;
  dependsOn: string[];
  parallelGroup?: string;
}

export interface ExecutionPlanView {
  planId: string;
  title?: string;
  nodes: ExecutionPlanNodeView[];
}

export interface ArtifactFile {
  id: string;
  name: string;
  role: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  contentUrl: string;
}

export interface VisualizationDescriptor {
  chartId: string;
  title: string;
  displayOrder: number;
  fileName: string;
  businessCategory: string;
  description?: string;
  status?: 'available' | 'failed' | 'not_applicable';
}

export interface Artifact {
  id: string;
  turnId: string;
  artifactType: string;
  status: 'succeeded' | 'partial' | 'integrity_failed';
  producer: { skillName: string; jobId: string };
  summary: Record<string, unknown>;
  warnings: string[];
  files: ArtifactFile[];
}

export interface ResultReference {
  artifactId: string;
  title: string;
  artifactType?: string;
  manifestUrl?: string;
  kind: 'quality' | 'forecast' | 'generic';
  status: 'succeeded' | 'partial';
  summary: string;
}

export interface TurnView {
  id: string;
  status: TurnStatus;
  startedAt: string;
  finishedAt?: string;
  problem?: ProblemDetails;
  messages: Message[];
  activities: ActivityItem[];
  executionPlan?: ExecutionPlanView;
  questionSet?: QuestionSet;
  results: ResultReference[];
}

export interface UploadSnapshot {
  id: string;
  sourceRef: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  mediaType: string;
}

export interface SessionDetail extends SessionSummary {
  createdAt: string;
  lastEventId: number;
  turns: TurnView[];
  uploads: UploadSnapshot[];
  artifacts: Artifact[];
  skillJobs: SkillJobView[];
  activeQuestionSet?: QuestionSet;
  disclosure: string;
}

export interface BusinessEvent {
  protocolVersion: '1.0';
  eventId: number;
  sessionId: string;
  turnId: string | null;
  type:
    | 'turn.started'
    | 'execution.plan'
    | 'plan.updated'
    | 'agent.activity'
    | 'skill.started'
    | 'skill.progress'
    | 'skill.completed'
    | 'input.required'
    | 'artifact.created'
    | 'assistant.message'
    | 'turn.completed'
    | 'turn.partial'
    | 'turn.failed'
    | 'turn.cancelled'
    | 'turn.interrupted';
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  correlationId: string;
  recovery?: string;
}
