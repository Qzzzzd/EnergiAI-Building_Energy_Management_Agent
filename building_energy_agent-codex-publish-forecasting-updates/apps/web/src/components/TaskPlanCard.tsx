import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  HelpCircle,
  LoaderCircle,
  RotateCcw,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { SkillJobView, TurnView } from '../domain';
import {
  buildTaskPlan,
  isTaskPlanTerminal,
  planStatusLabel,
  skillDisplayName,
  type PlanNode,
  type PlanNodeStatus,
} from '../domain/plans';
import { formatDuration } from '../ui/format';

const statusIcons: Record<PlanNodeStatus, LucideIcon> = {
  pending: Circle,
  queued: Clock3,
  running: LoaderCircle,
  needs_input: HelpCircle,
  cancelling: LoaderCircle,
  completed: CheckCircle2,
  partial: AlertTriangle,
  failed: XCircle,
  cancelled: Ban,
  interrupted: AlertTriangle,
};

const nodeStatusLabels: Record<PlanNodeStatus, string> = {
  pending: '等待前置步骤',
  queued: '已排队',
  running: '运行中',
  needs_input: '需要确认',
  cancelling: '取消中',
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const lifecycleStageValues = new Set([
  'queued',
  'running',
  'completed',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
  'needs_input',
  'cancelling',
]);

function meaningfulStage(stage: string | undefined): string | undefined {
  const normalized = stage?.trim();
  return normalized && !lifecycleStageValues.has(normalized.toLowerCase())
    ? normalized
    : undefined;
}

function displayNodeStatus(node: PlanNode, planStatus: TurnView['status']): PlanNodeStatus {
  if (isTaskPlanTerminal(planStatus)) {
    if (
      node.status === 'running' ||
      node.status === 'queued' ||
      node.status === 'needs_input' ||
      node.status === 'cancelling'
    ) {
      return planStatus === 'completed' ? 'completed' : planStatus;
    }
    return node.status;
  }
  if (
    planStatus === 'needs_input' &&
    (node.status === 'running' || node.status === 'queued' || node.status === 'cancelling')
  ) {
    return 'needs_input';
  }
  return node.status;
}

function PlanNodeItem({
  node,
  planStatus,
  dependencyNames,
  isCurrent,
}: {
  node: PlanNode;
  planStatus: TurnView['status'];
  dependencyNames: string[];
  isCurrent?: boolean;
}) {
  const displayStatus = displayNodeStatus(node, planStatus);
  const Icon = statusIcons[displayStatus];
  const terminalPlan = isTaskPlanTerminal(planStatus);
  const displayName = node.skillName ? skillDisplayName(node.skillName) : node.displayName;
  const preparing =
    displayStatus === 'pending' && planStatus === 'running' && node.dependsOn.length === 0;
  const statusLabel = preparing ? '准备中' : nodeStatusLabels[displayStatus];
  const stage = meaningfulStage(node.stage);
  const statusText = stage
    ? `${statusLabel} · ${stage}`
    : statusLabel;
  const percent = node.progress && node.progress.total > 0
    ? Math.min(100, Math.max(0, (node.progress.completed / node.progress.total) * 100))
    : null;
  const indeterminate =
    percent !== null &&
    !terminalPlan &&
    ['running', 'queued', 'cancelling'].includes(displayStatus) &&
    (percent === 0 || percent === 100);
  return (
    <div
      className={`plan-node status-${displayStatus}${isCurrent ? ' plan-node-current' : ''}`}
      data-node-status={displayStatus}
    >
      <span className="plan-node-icon" aria-hidden="true">
        <Icon
          size={17}
          className={
            !terminalPlan && (displayStatus === 'running' || displayStatus === 'cancelling')
              ? 'spin'
              : undefined
          }
        />
      </span>
      <span className="plan-node-copy">
        <span className="plan-node-name">{displayName}</span>
        <span className="plan-node-status">{statusText}</span>
        {dependencyNames.length > 0 ? (
          <span className="plan-node-dependencies">依赖：{dependencyNames.join('、')}</span>
        ) : null}
        {indeterminate ? (
          <span className="right-progress right-progress-indeterminate">
            <span aria-hidden="true" />
            <span>进行中</span>
          </span>
        ) : percent !== null && !terminalPlan && displayStatus !== 'completed' ? (
          <span className="right-progress">
            <progress max="100" value={percent}>
              {Math.round(percent)}%
            </progress>
            <span>{Math.round(percent)}%</span>
          </span>
        ) : null}
        {node.resultRefs.length > 0 ? (
          <span className="plan-node-artifacts">已产出 {node.resultRefs.length} 项结果</span>
        ) : null}
        {node.warnings.length > 0 && displayStatus !== 'completed' ? (
          <span className="plan-node-warning">{node.warnings[0]}</span>
        ) : null}
      </span>
    </div>
  );
}

function branchLabel(nodes: PlanNode[], index: number): string {
  const skillNames = new Set(nodes.map((node) => node.skillName));
  if (skillNames.has('building-energy-data-quality')) return '质量分支';
  if (skillNames.has('building-energy-load-forecasting')) return '预测分支';
  if (skillNames.has('building-energy-data-processing')) return '预测数据分支';
  if (skillNames.has('building-energy-data-parsing')) return '数据准备分支';
  if (skillNames.has('building-energy-report-generation')) return '报表分支';
  return `并行分支 ${index + 1}`;
}

function branchStatus(nodes: PlanNode[]): string {
  if (nodes.length === 0) return '等待';
  if (nodes.some((node) => node.status === 'failed')) return '失败';
  if (nodes.some((node) => node.status === 'cancelled')) return '已取消';
  if (nodes.some((node) => node.status === 'interrupted')) return '已中断';
  if (nodes.every((node) => node.status === 'completed')) return '已完成';
  if (nodes.some((node) => ['running', 'queued', 'cancelling'].includes(node.status))) {
    return '执行中';
  }
  if (nodes.some((node) => node.status === 'needs_input')) return '等待输入';
  return '部分完成';
}

function splitParallelNodes(nodes: PlanNode[]): PlanNode[][] {
  const groups = new Map<string, PlanNode[]>();
  for (const node of nodes) {
    const key = node.skillName ?? node.id;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function appendBranchDescendants(
  branchNodes: PlanNode[],
  allNodes: PlanNode[],
  attachedNodeIds: Set<string>,
): PlanNode[] {
  const nodes = [...branchNodes];
  const nodeIds = new Set(nodes.map((node) => node.id));
  let foundDependentNode = true;
  while (foundDependentNode) {
    foundDependentNode = false;
    for (const candidate of allNodes) {
      if (
        candidate.parallelGroup ||
        nodeIds.has(candidate.id) ||
        attachedNodeIds.has(candidate.id) ||
        candidate.dependsOn.length === 0 ||
        !candidate.dependsOn.every((dependency) => nodeIds.has(dependency))
      ) {
        continue;
      }
      nodes.push(candidate);
      nodeIds.add(candidate.id);
      attachedNodeIds.add(candidate.id);
      foundDependentNode = true;
    }
  }
  return nodes;
}

function PlanGraph({ turn, jobs }: { turn: TurnView; jobs: SkillJobView[] }) {
  const plan = buildTaskPlan(turn, jobs);
  if (plan.nodes.length === 0) {
    return <p className="plan-sync-state">执行阶段正在同步，收到真实执行事件后会显示节点。</p>;
  }
  const nodeNames = new Map(
    plan.nodes.map((node) => [node.id, node.skillName ? skillDisplayName(node.skillName) : node.displayName]),
  );
  const dependencyNames = (node: PlanNode) =>
    node.dependsOn
      .map((dependency) => nodeNames.get(dependency))
      .filter((dependency): dependency is string => Boolean(dependency));
  const renderedParallelGroups = new Set<string>();
  const renderedNodeIds = new Set<string>();
  const graphItems: ReactNode[] = [];
  for (const node of plan.nodes) {
    if (renderedNodeIds.has(node.id)) continue;
    if (!node.parallelGroup) {
      graphItems.push(
        <PlanNodeItem
          key={node.id}
          node={node}
          planStatus={turn.status}
          dependencyNames={dependencyNames(node)}
          isCurrent={plan.currentNode?.id === node.id}
        />,
      );
      renderedNodeIds.add(node.id);
      continue;
    }
    if (renderedParallelGroups.has(node.parallelGroup)) continue;
    renderedParallelGroups.add(node.parallelGroup);
    const branch = plan.branches.find((candidate) => candidate.id === node.parallelGroup);
    if (!branch) continue;
    const branchGroups = splitParallelNodes(branch.nodes).map((branchNodes) =>
      appendBranchDescendants(branchNodes, plan.nodes, renderedNodeIds),
    );
    for (const branchNodes of branchGroups) {
      for (const branchNode of branchNodes) renderedNodeIds.add(branchNode.id);
    }
    graphItems.push(
      <Fragment key={`branch:${branch.id}`}>
        {graphItems.length > 0 ? (
          <span className="plan-branch-connector" aria-hidden="true" />
        ) : null}
        <div className="branch-split" aria-label="计划并行执行分支">
          {branchGroups.map((branchNodes, index) => (
            <section className={`branch branch-${index}`} key={branchNodes[0]?.id ?? index}>
              <span className="branch-label">{branchLabel(branchNodes, index)}</span>
              {branchNodes.map((branchNode) => (
                <PlanNodeItem
                  key={branchNode.id}
                  node={branchNode}
                  planStatus={turn.status}
                  dependencyNames={dependencyNames(branchNode)}
                  isCurrent={plan.currentNode?.id === branchNode.id}
                />
              ))}
            </section>
          ))}
        </div>
      </Fragment>,
    );
  }
  return <div className={plan.isIntegrated ? 'combined-plan' : 'linear-plan'}>{graphItems}</div>;
}

export function TaskPlanCard({
  turn,
  jobs,
  onRerun,
}: {
  turn: TurnView;
  jobs: SkillJobView[];
  onRerun?: () => void;
}) {
  const plan = buildTaskPlan(turn, jobs);
  const live = !isTaskPlanTerminal(turn.status);
  const clockRunning =
    !isTaskPlanTerminal(turn.status) &&
    (turn.status === 'queued' || turn.status === 'running' || turn.status === 'cancelling');
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!clockRunning) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [clockRunning]);
  const elapsed = formatDuration(
    turn.startedAt,
    clockRunning ? new Date(clock).toISOString() : turn.finishedAt,
  );
  const currentNode = plan.currentNode;
  const currentLabel = currentNode
    ? currentNode.skillName
      ? skillDisplayName(currentNode.skillName)
      : currentNode.displayName
    : '准备分析';
  const currentNodePreparing =
    currentNode?.status === 'pending' &&
    turn.status === 'running' &&
    currentNode.dependsOn.length === 0;
  const currentStage =
    meaningfulStage(currentNode?.stage) ??
    (currentNode
      ? currentNodePreparing
        ? '正在启动专业 Skill'
        : nodeStatusLabels[currentNode.status]
      : planStatusLabel(turn.status));
  const currentNodeWaiting = currentNode
    ? currentNode.status === 'queued' || (currentNode.status === 'pending' && !currentNodePreparing)
    : false;
  const partialBranchSummary = plan.isIntegrated
    ? plan.branches
        .flatMap((branch) =>
          splitParallelNodes(branch.nodes).map(
            (branchNodes, index) => `${branchLabel(branchNodes, index)}：${branchStatus(branchNodes)}`,
          ),
        )
        .join('；')
    : undefined;

  const graph = <PlanGraph turn={turn} jobs={jobs} />;
  if (turn.status === 'completed') {
    return (
      <details className="task-plan-card completed-plan-card" aria-label={`${plan.title}执行过程`}>
        <summary className="completed-plan-summary">
          <span>
            <span className="section-kicker">执行过程</span>
            <strong>{plan.title}</strong>
          </span>
          <span className="completed-plan-actions">
            <span className="plan-status plan-status-completed">已完成</span>
            <span className="completed-plan-expand" aria-label="展开执行过程" title="展开执行过程">
              <ChevronDown size={15} aria-hidden="true" />
            </span>
          </span>
        </summary>
        <div className="completed-plan-body">
          {graph}
          {onRerun && (
            <button className="quiet-action" type="button" onClick={onRerun}>
              <RotateCcw size={14} aria-hidden="true" />
              重新运行
            </button>
          )}
        </div>
      </details>
    );
  }

  return (
    <section
      className={`task-plan-card${isTaskPlanTerminal(turn.status) ? ' terminal-plan-card' : ''}`}
      aria-label={`${plan.title}执行过程`}
      data-plan-status={turn.status}
    >
      <header className="plan-header">
        <div>
          <span className="section-kicker">
            {live ? `执行过程${elapsed ? ` · ${elapsed}` : ''}` : '执行过程'}
          </span>
          <h3>{plan.title}</h3>
        </div>
        <span className={`plan-status plan-status-${turn.status}`}>
          {planStatusLabel(turn.status)}
        </span>
      </header>
      {live ? (
        <div
          className={`plan-live-status${turn.status === 'needs_input' ? ' plan-terminal-status' : ''}`}
        >
          {turn.status === 'needs_input' ? (
            <>
              <strong role="status">需要确认：{currentLabel}</strong>
              <span>{currentStage}</span>
            </>
          ) : (
            <>
              <div className="plan-live-heading">
                <span className="plan-live-indicator" aria-hidden="true" />
                <span className="plan-live-copy">
                  <strong>
                    {currentNode
                      ? `${currentNodePreparing ? '正在准备' : currentNodeWaiting ? '等待前置步骤' : '正在执行'}：${currentLabel}`
                      : '正在准备分析'}
                  </strong>
                  <span>{currentStage}</span>
                </span>
              </div>
              <span className="sr-only" role="status" aria-live="polite">
                {currentLabel}：{currentStage}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className="plan-terminal-status" role="status">
          <strong>{planStatusLabel(turn.status)}</strong>
          {partialBranchSummary && <span>{partialBranchSummary}</span>}
        </div>
      )}
      {graph}
      {onRerun && isTaskPlanTerminal(turn.status) && (
        <footer className="plan-actions">
          <button className="quiet-action" type="button" onClick={onRerun}>
            <RotateCcw size={14} aria-hidden="true" />
            重新运行
          </button>
        </footer>
      )}
    </section>
  );
}
