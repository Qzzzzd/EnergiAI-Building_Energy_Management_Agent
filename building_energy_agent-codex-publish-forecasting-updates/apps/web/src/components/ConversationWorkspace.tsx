import {
  Archive,
  ArrowRight,
  Activity,
  BarChart3,
  Building2,
  Bot,
  CircleAlert,
  ClipboardCheck,
  FileSpreadsheet,
  Layers3,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ModelOption, ReasoningLevel, SessionDetail } from '../domain';
import { formatBytes, formatWhen } from '../ui/format';
import { Composer } from './Composer';
import { QuestionGroup } from './QuestionGroup';
import { TaskPlanCard } from './TaskPlanCard';
import { taskPresets, type TaskPreset } from './taskPresets';

interface ConversationWorkspaceProps {
  session: SessionDetail | null;
  busy: boolean;
  hasModel: boolean;
  models?: ModelOption[];
  selectedModel?: string;
  selectedReasoning?: ReasoningLevel;
  modelLocked?: boolean;
  onModelChange?(model: string, reasoning: ReasoningLevel): void;
  onSend(content: string, files: File[], reuseAvailableData?: boolean): void;
  onCancel(): void;
  onAnswer(questionSetId: string, answers: Record<string, string>): void;
  onSaveDraft(questionSetId: string, draft: Record<string, string>): Promise<void>;
  onOpenResult?(turnId: string, artifactId: string): void;
  onRerun?(turnId: string): void;
  taskPreset?: TaskPreset | null;
  composerFocusRequest?: number;
  onTaskPreset?(preset: TaskPreset): void;
  onRemoveTaskPreset?(): void;
}

function TaskEntryGrid({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect(preset: TaskPreset): void;
}) {
  return (
    <div className="task-entry-grid" aria-label="业务任务入口">
      {taskPresets.map((task) => {
        const Icon =
          task.id === 'forecast' ? BarChart3 : task.id === 'quality' ? ClipboardCheck : Layers3;
        return (
          <button
            className="task-entry-card"
            key={task.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(task)}
          >
            <span className="task-entry-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
            <span>
              <strong>{task.title}</strong>
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

function MessageAttachments({
  sourceRefs,
  uploads,
}: {
  sourceRefs: string[] | undefined;
  uploads: SessionDetail['uploads'];
}) {
  if (!sourceRefs?.length) return null;
  const uploadByRef = new Map(uploads.map((upload) => [upload.sourceRef, upload]));
  const attached = sourceRefs
    .map((sourceRef) => uploadByRef.get(sourceRef))
    .filter((upload): upload is SessionDetail['uploads'][number] => Boolean(upload));
  if (attached.length === 0) return null;

  return (
    <div className="message-files" aria-label="消息附件">
      {attached.map((upload, index) => (
        <span key={`${upload.sourceRef}-${index}`}>
          <FileSpreadsheet size={15} aria-hidden="true" />
          <span>
            <strong>{upload.name}</strong>
            <small>{formatBytes(upload.sizeBytes)}</small>
          </span>
        </span>
      ))}
    </div>
  );
}

function visibleMessageContent(
  message: SessionDetail['turns'][number]['messages'][number],
): string {
  if (
    message.role !== 'user' ||
    !message.content.startsWith('以下是 question_set_id=') ||
    !message.content.endsWith('请在同一 thread 中继续原任务，并复用可恢复的 Skill job ID。')
  ) {
    return message.content;
  }

  try {
    const payload = JSON.parse(message.content.split('\n')[1] ?? '') as {
      answers?: Array<{ answer?: unknown }>;
    };
    const answers = (payload.answers ?? [])
      .map((item) => (typeof item.answer === 'string' ? item.answer.trim() : ''))
      .filter(Boolean);
    return answers.length > 0 ? `已确认：${answers.join('；')}` : '已提交确认信息。';
  } catch {
    return message.content;
  }
}

function humanizeFailureDetail(detail: string): string {
  if (/reconnect|request timed out|timed out|timeout|ETIMEDOUT/i.test(detail)) {
    return '模型服务连接超时：多次重试后仍未收到响应，本次没有生成结果。请稍后重试；如果连续发生，请检查网络代理或运行 doctor。';
  }
  if (/login|auth|unauthorized|credential/i.test(detail)) {
    return '模型服务登录状态不可用，请重新登录 Codex 后重试。';
  }
  if (/usage limit|quota exceeded|rate limit/i.test(detail)) {
    return '当前模型暂时不可用或额度受限，请稍后重试，或选择其他可用模型。';
  }
  return detail;
}

function turnFailureDetail(turn: SessionDetail['turns'][number]): string {
  const activityDetail = [...turn.activities]
    .reverse()
    .find((activity) => activity.kind === 'error' && activity.summary)?.summary;
  const detail = turn.problem?.detail ?? activityDetail;
  return humanizeFailureDetail(detail ?? '本次请求未完成，没有生成结果。请稍后重试。');
}

function TurnFailureMessage({ turn }: { turn: SessionDetail['turns'][number] }) {
  const interrupted = turn.status === 'interrupted';
  return (
    <article className="message-row message-row-assistant assistant turn-failure-message">
      <span className="agent-avatar" aria-label="请求未完成">
        <CircleAlert size={18} aria-hidden="true" />
      </span>
      <div className="message-bubble" role="alert">
        <span className="message-author">
          <span>{interrupted ? '本次请求已中断' : '本次请求未完成'}</span>
          <time dateTime={turn.finishedAt ?? turn.startedAt}>
            {formatWhen(turn.finishedAt ?? turn.startedAt)}
          </time>
        </span>
        <p>{turnFailureDetail(turn)}</p>
      </div>
    </article>
  );
}

export function ConversationWorkspace({
  session,
  busy,
  hasModel,
  models = [],
  selectedModel = '',
  selectedReasoning = 'xhigh',
  modelLocked = false,
  onModelChange = () => undefined,
  onSend,
  onCancel,
  onAnswer,
  onSaveDraft,
  onRerun = () => undefined,
  taskPreset = null,
  composerFocusRequest = 0,
  onTaskPreset = () => undefined,
  onRemoveTaskPreset = () => undefined,
}: ConversationWorkspaceProps) {
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const turns = session?.turns ?? [];
  const latestTurn = turns.at(-1);
  const activeTurn =
    latestTurn && ['queued', 'running', 'needs_input', 'cancelling'].includes(latestTurn.status)
      ? latestTurn
      : undefined;
  const questionSet = session?.activeQuestionSet ?? activeTurn?.questionSet;
  const running = ['queued', 'running', 'cancelling'].includes(activeTurn?.status ?? '');
  const archived = Boolean(session?.archived);
  const taskActionsDisabled = busy || running || Boolean(questionSet) || archived;
  const messageCount = turns.reduce((count, turn) => count + turn.messages.length, 0);

  useEffect(() => {
    const scroll = conversationScrollRef.current;
    if (!scroll || !session) return;
    scroll.scrollTop = scroll.scrollHeight;
  }, [messageCount, session?.id, turns.length]);

  const renderMessage = (message: SessionDetail['turns'][number]['messages'][number]) => (
    <article
      key={message.id}
      className={`message-row message ${message.role} message-${message.role}`}
    >
      {message.role === 'assistant' && (
        <span className="agent-avatar message-avatar" aria-label="建筑能源 Agent">
          <Bot size={18} aria-hidden="true" />
        </span>
      )}
      <div className="message-bubble">
        <span className="message-author">
          {message.role === 'assistant'
            ? '建筑能源 Agent'
            : message.role === 'system'
              ? '系统'
              : null}
          <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
        </span>
        <p>{visibleMessageContent(message)}</p>
        <MessageAttachments sourceRefs={message.sourceRefs} uploads={session?.uploads ?? []} />
      </div>
    </article>
  );

  const renderEmbeddedAssistantMessage = (
    message: SessionDetail['turns'][number]['messages'][number],
  ) => (
    <section className="turn-response-copy" key={message.id}>
      <span className="message-author">
        <span>建筑能源 Agent</span>
        <time dateTime={message.createdAt}>{formatWhen(message.createdAt)}</time>
      </span>
      <p>{message.content}</p>
      <MessageAttachments sourceRefs={message.sourceRefs} uploads={session?.uploads ?? []} />
    </section>
  );

  return (
    <main className="conversation-workspace" id="main-content">
      <div ref={conversationScrollRef} className="conversation-scroll" aria-live="polite">
        {!session || turns.length === 0 ? (
          <section className="conversation-empty">
            <div className="welcome-state">
              <span className="welcome-icon">
                <Building2 size={27} aria-hidden="true" />
              </span>
              <span className="section-kicker">建筑能源专业智能体</span>
              <h2>把数据放进对话，直接说出目标</h2>
              <p>上传数据，或直接说明目标</p>
              <TaskEntryGrid disabled={taskActionsDisabled} onSelect={onTaskPreset} />
              {!hasModel && (
                <div className="empty-warning">
                  <ShieldAlert size={17} />
                  当前没有可用模型。请运行 doctor 检查 Codex 登录与模型 allowlist。
                </div>
              )}
            </div>
          </section>
        ) : (
          <div className="message-stream turn-list">
            {turns.map((turn) => {
              const jobs = session.skillJobs.filter((job) => job.turnId === turn.id);
              const hasWorkflowPlan =
                jobs.length > 0 ||
                Boolean(turn.executionPlan) ||
                turn.activities.some(
                  (activity) => activity.kind === 'plan' || activity.kind === 'skill',
                );
              const isThinking =
                activeTurn?.id === turn.id &&
                !hasWorkflowPlan &&
                ['queued', 'running', 'cancelling'].includes(turn.status);
              const userMessages = turn.messages.filter((message) => message.role !== 'assistant');
              const assistantMessages = turn.messages.filter(
                (message) => message.role === 'assistant',
              );
              const terminal = [
                'completed',
                'partial',
                'failed',
                'cancelled',
                'interrupted',
              ].includes(turn.status);
              const failed = turn.status === 'failed' || turn.status === 'interrupted';

              return (
                <section key={turn.id} className="turn-block">
                  {userMessages.map(renderMessage)}

                  {hasWorkflowPlan ? (
                    <article className="message-row message-row-assistant assistant plan-message">
                      <span className="agent-avatar" aria-label="建筑能源 Agent">
                        <Activity size={18} aria-hidden="true" />
                      </span>
                      <div className="plan-message-body">
                        <div className="turn-response-shell">
                          <TaskPlanCard
                            turn={turn}
                            jobs={jobs}
                            {...(terminal ? { onRerun: () => onRerun(turn.id) } : {})}
                          />
                          {assistantMessages.map(renderEmbeddedAssistantMessage)}
                        </div>
                        {activeTurn?.id === turn.id && (
                          <div className="turn-actions">
                            <button
                              className="cancel-action"
                              type="button"
                              disabled={busy}
                              onClick={onCancel}
                            >
                              取消任务
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  ) : isThinking ? (
                    <article className="message-row message-row-assistant assistant thinking-message">
                      <span className="agent-avatar" aria-label="智能体正在思考">
                        <Activity size={18} aria-hidden="true" />
                      </span>
                      <div className="conversation-progress" role="status" aria-live="polite">
                        <span className="conversation-stage">
                          <span className="planning-status-dot" aria-hidden="true" />
                          <span className="thinking-copy">
                            正在思考
                            <span className="thinking-dots" aria-hidden="true">
                              <span>·</span>
                              <span>·</span>
                              <span>·</span>
                            </span>
                          </span>
                        </span>
                        <button
                          className="cancel-action thinking-cancel-action"
                          type="button"
                          disabled={busy}
                          onClick={onCancel}
                        >
                          停止回复
                        </button>
                      </div>
                    </article>
                  ) : (
                    turn.messages
                      .filter((message) => message.role === 'assistant')
                      .map(renderMessage)
                  )}
                  {failed && <TurnFailureMessage turn={turn} />}
                </section>
              );
            })}
          </div>
        )}
      </div>

      <div className="conversation-controls">
        {archived && (
          <div className="archived-session-notice" role="status">
            <Archive size={17} aria-hidden="true" />
            <span>
              <strong>该会话已归档</strong>
              <small>可继续查看记录和结果；恢复会话后才能上传文件、提问或启动分析。</small>
            </span>
          </div>
        )}
        {activeTurn?.status === 'needs_input' && !questionSet && (
          <div className="inline-problem">
            <CircleAlert size={17} />
            等待输入，但问题组尚未恢复。请刷新或运行 doctor 检查持久化状态。
          </div>
        )}
        {questionSet?.status === 'pending' && (
          <QuestionGroup
            questionSet={questionSet}
            busy={busy}
            onSave={(draft) => onSaveDraft(questionSet.id, draft)}
            onSubmit={(answers) => onAnswer(questionSet.id, answers)}
          />
        )}
        <Composer
          busy={busy}
          disabled={archived || running || Boolean(questionSet)}
          hasAvailableData={Boolean(session?.uploads.length)}
          {...(archived
            ? { disabledMessage: '恢复会话后可继续输入' }
            : questionSet
              ? { disabledMessage: '请先完成上方确认' }
              : {})}
          models={models}
          selectedModel={selectedModel}
          selectedReasoning={selectedReasoning}
          modelLocked={modelLocked}
          onModelChange={onModelChange}
          intent={taskPreset}
          focusRequest={composerFocusRequest}
          onRemoveIntent={onRemoveTaskPreset}
          onSend={onSend}
        />
      </div>
    </main>
  );
}
