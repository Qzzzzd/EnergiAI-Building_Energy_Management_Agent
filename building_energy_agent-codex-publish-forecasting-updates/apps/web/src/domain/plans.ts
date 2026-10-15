import type {
  ActivityItem,
  ArtifactRefView,
  ExecutionPlanNodeView,
  ExecutionPlanView,
  SkillJobStatus,
  SkillJobView,
  TurnStatus,
  TurnView,
} from '../domain';

export type PlanNodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'cancelling'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface PlanNode {
  id: string;
  displayName: string;
  skillName?: string;
  jobId?: string;
  branch: string;
  status: PlanNodeStatus;
  dependsOn: string[];
  parallelGroup?: string;
  stage?: string;
  progress?: { completed: number; total: number; unit: string };
  warnings: string[];
  resultRefs: ArtifactRefView[];
}

export interface PlanBranch {
  id: string;
  label: string;
  nodes: PlanNode[];
}

export interface TaskPlanView {
  title: string;
  status: TurnStatus;
  nodes: PlanNode[];
  branches: PlanBranch[];
  isIntegrated: boolean;
  currentNode?: PlanNode;
  hasProgress: boolean;
  declared: boolean;
  planId?: string;
}

const knownSkillNames: Record<string, string> = {
  'building-energy-data-parsing': '建筑能源数据解析',
  'building-energy-data-processing': '建筑能源预测数据处理',
  'building-energy-data-quality': '建筑能源数据质量评估',
  'building-energy-load-forecasting': '建筑能源负荷预测',
  'building-energy-report-generation': '建筑能源专业报表生成',
};

const terminalPlanStatuses = new Set<TurnStatus>([
  'completed',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

const activeNodeStatuses = new Set<PlanNodeStatus>([
  'pending',
  'queued',
  'running',
  'needs_input',
  'cancelling',
]);

function nodeStatus(status: SkillJobStatus | ActivityItem['status'] | undefined): PlanNodeStatus {
  if (status === undefined) return 'pending';
  if (status === 'succeeded' || status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'cancelling') return 'cancelling';
  if (status === 'needs_input') return 'needs_input';
  if (status === 'queued') return 'queued';
  if (status === 'partial') return 'partial';
  if (status === 'pending') return 'pending';
  return 'running';
}

function statusForTurn(status: PlanNodeStatus, turnStatus: TurnStatus): PlanNodeStatus {
  if (
    turnStatus === 'needs_input' &&
    (status === 'running' ||
      status === 'queued' ||
      status === 'needs_input' ||
      status === 'cancelling')
  ) {
    return 'needs_input';
  }
  if (activeNodeStatuses.has(status) && terminalPlanStatuses.has(turnStatus)) {
    return turnStatus;
  }
  return status;
}

function activityForJob(turn: TurnView, job: SkillJobView): ActivityItem | undefined {
  return turn.activities.find(
    (item) => item.jobId === job.jobId || item.id === `skill:${job.jobId}`,
  );
}

function activityForSkill(
  turn: TurnView,
  skillName: string,
  usedActivityIds: Set<string>,
): ActivityItem | undefined {
  const activity = [...turn.activities].reverse().find((item) => {
    if (usedActivityIds.has(item.id)) return false;
    if (item.kind === 'skill' && item.skillName === skillName) return true;
    if (item.kind !== 'command') return false;
    const command = `${item.title} ${item.summary ?? ''}`;
    const match = command.match(/\bskill-run\s+(?:start|resume)\s+--skill\s+([^\s'"]+)/);
    return match?.[1] === skillName;
  });
  if (activity) usedActivityIds.add(activity.id);
  if (activity?.kind === 'command') {
    return {
      ...activity,
      kind: 'skill',
      skillName,
      status: activity.status === 'failed' ? 'failed' : 'running',
    };
  }
  return activity;
}

function activeActivityForSkill(
  turn: TurnView,
  skillName: string,
  usedActivityIds: Set<string>,
): ActivityItem | undefined {
  const activity = [...turn.activities].reverse().find((item) => {
    if (usedActivityIds.has(item.id)) return false;
    if (item.status !== 'running') return false;
    if (item.kind === 'skill' && item.skillName === skillName) return true;
    if (item.kind !== 'command') return false;
    const command = `${item.title} ${item.summary ?? ''}`;
    const match = command.match(/\bskill-run\s+(?:start|resume)\s+--skill\s+([^\s'"]+)/);
    return match?.[1] === skillName;
  });
  if (activity) usedActivityIds.add(activity.id);
  if (!activity) return undefined;
  return activity.kind === 'command'
    ? { ...activity, kind: 'skill', skillName, status: 'running' }
    : activity;
}

function mergeResultRefs(
  job: SkillJobView | undefined,
  activity: ActivityItem | undefined,
): ArtifactRefView[] {
  return [...(job?.resultRefs ?? []), ...(activity?.resultRefs ?? [])].filter(
    (ref, index, refs) =>
      refs.findIndex((candidate) => candidate.artifactId === ref.artifactId) === index,
  );
}

function preferredDeclaredJob(jobs: SkillJobView[], turnStatus: TurnStatus): SkillJobView | undefined {
  const priority = (job: SkillJobView): number => {
    if (turnStatus === 'needs_input' && job.status === 'needs_input') return 0;
    if (job.status === 'running') return 1;
    if (job.status === 'queued') return 2;
    if (job.status === 'needs_input') return 3;
    if (job.status === 'cancelling') return 4;
    if ((job.resultRefs?.length ?? 0) > 0) return 5;
    if (job.status === 'succeeded' || job.status === 'partial') return 6;
    return 7;
  };
  return [...jobs].reverse().reduce<SkillJobView | undefined>(
    (selected, candidate) =>
      !selected || priority(candidate) < priority(selected) ? candidate : selected,
    undefined,
  );
}

function buildNode(
  declared: ExecutionPlanNodeView | undefined,
  turn: TurnView,
  job: SkillJobView | undefined,
  activity: ActivityItem | undefined,
): PlanNode {
  const skillName = declared?.skillName ?? job?.skillName ?? activity?.skillName;
  const status = statusForTurn(nodeStatus(job?.status ?? activity?.status), turn.status);
  const parallelGroup = declared?.parallelGroup;
  const stage = job?.stage ?? activity?.stage;
  const progress = job?.progress ?? activity?.progress;
  return {
    id: declared?.id ?? job?.jobId ?? activity?.id ?? 'analysis-step',
    displayName:
      declared?.title ?? (skillName ? (knownSkillNames[skillName] ?? '分析步骤') : '分析步骤'),
    ...(skillName ? { skillName } : {}),
    ...(job?.jobId ? { jobId: job.jobId } : activity?.jobId ? { jobId: activity.jobId } : {}),
    branch: parallelGroup ? `parallel:${parallelGroup}` : 'main',
    status,
    dependsOn: declared?.dependsOn ?? [],
    ...(parallelGroup ? { parallelGroup } : {}),
    ...(stage !== undefined ? { stage } : {}),
    ...(progress !== undefined ? { progress } : {}),
    warnings: [...new Set([...(job?.warnings ?? []), ...(activity?.warnings ?? [])])],
    resultRefs: mergeResultRefs(job, activity),
  };
}

function declaredNodes(plan: ExecutionPlanView, turn: TurnView, jobs: SkillJobView[]): PlanNode[] {
  const remainingJobs = [...jobs];
  const usedActivityIds = new Set<string>();
  const declaredSkillCounts = new Map<string, number>();
  for (const node of plan.nodes) {
    declaredSkillCounts.set(node.skillName, (declaredSkillCounts.get(node.skillName) ?? 0) + 1);
  }
  return plan.nodes
    .map((declared) => {
      const matchingJobs = remainingJobs.filter(
        (candidate) => candidate.skillName === declared.skillName,
      );
      const job = preferredDeclaredJob(matchingJobs, turn.status);
      if (job) {
        const removeAllMatches = declaredSkillCounts.get(declared.skillName) === 1;
        for (let index = remainingJobs.length - 1; index >= 0; index -= 1) {
          if (
            remainingJobs[index]?.skillName === declared.skillName &&
            (removeAllMatches || remainingJobs[index]?.jobId === job.jobId)
          ) {
            remainingJobs.splice(index, 1);
          }
        }
      }
      const activeActivity =
        job?.status === 'queued'
          ? activeActivityForSkill(turn, declared.skillName, usedActivityIds)
          : undefined;
      const activity =
        activeActivity ??
        (job
          ? activityForJob(turn, job)
          : activityForSkill(turn, declared.skillName, usedActivityIds));
      const effectiveJob =
        activeActivity && job
          ? (() => {
              const { stage: _queuedStage, ...jobWithoutStage } = job;
              return {
                ...jobWithoutStage,
                status: 'running' as const,
                ...(activeActivity.stage ? { stage: activeActivity.stage } : {}),
              };
            })()
          : job;
      return buildNode(declared, turn, effectiveJob, activity);
    })
    .concat(
      remainingJobs
        .filter((job) => !declaredSkillCounts.has(job.skillName))
        .map((job) => buildNode(undefined, turn, job, activityForJob(turn, job))),
    );
}

function legacyNodes(turn: TurnView, jobs: SkillJobView[]): PlanNode[] {
  const usedJobIds = new Set<string>();
  const nodes = jobs.map((job) => {
    usedJobIds.add(job.jobId);
    return buildNode(undefined, turn, job, activityForJob(turn, job));
  });
  for (const activity of turn.activities) {
    if (activity.kind !== 'skill' || (activity.jobId && usedJobIds.has(activity.jobId))) continue;
    nodes.push(buildNode(undefined, turn, undefined, activity));
  }
  return nodes;
}

function planBranches(nodes: PlanNode[]): PlanBranch[] {
  const groups = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    if (!node.parallelGroup) continue;
    const group = groups.get(node.parallelGroup) ?? [];
    group.push(node);
    groups.set(node.parallelGroup, group);
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    label: `并行组 · ${id}`,
    nodes: group,
  }));
}

export function skillDisplayName(skillName: string): string {
  return knownSkillNames[skillName] ?? '分析步骤';
}

export function planStatusLabel(status: TurnStatus): string {
  const labels: Record<TurnStatus, string> = {
    queued: '已排队',
    running: '正在执行',
    needs_input: '等待输入',
    completed: '已完成',
    partial: '部分完成',
    failed: '执行失败',
    cancelling: '取消中',
    cancelled: '已取消',
    interrupted: '已中断',
  };
  return labels[status] ?? '处理中';
}

export function isTaskPlanTerminal(status: TurnStatus): boolean {
  return terminalPlanStatuses.has(status);
}

export function buildTaskPlan(turn: TurnView, allJobs: SkillJobView[]): TaskPlanView {
  const jobs = allJobs.filter((job) => job.turnId === turn.id);
  const executionPlan = turn.executionPlan;
  const nodes = executionPlan ? declaredNodes(executionPlan, turn, jobs) : legacyNodes(turn, jobs);
  const branches = planBranches(nodes);
  const currentNode =
    nodes.find((node) => ['running', 'needs_input', 'cancelling'].includes(node.status)) ??
    nodes.find((node) => node.status === 'queued') ??
    nodes.find((node) => node.status === 'pending');
  return {
    title: executionPlan?.title ?? '执行计划',
    status: turn.status,
    nodes,
    branches,
    isIntegrated: branches.length > 0,
    ...(currentNode ? { currentNode } : {}),
    hasProgress: nodes.some((node) => node.progress !== undefined),
    declared: Boolean(executionPlan),
    ...(executionPlan ? { planId: executionPlan.planId } : {}),
  };
}
