import { AlertCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from './api/client';
import { ActivityInspector } from './components/ActivityInspector';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ConversationWorkspace } from './components/ConversationWorkspace';
import { ResultDetailsPanel } from './components/ResultDetailsPanel';
import { SessionRail } from './components/SessionRail';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { getTaskPreset, type TaskPreset, type TaskPresetId } from './components/taskPresets';
import { useWorkspace } from './state/workspace';

type SessionRailAction =
  | { kind: 'rename'; sessionId: string; title: string }
  | { kind: 'archive'; sessionId: string }
  | { kind: 'restore'; sessionId: string };

export function App({ client }: { client?: ApiClient }) {
  const { state, actions } = useWorkspace(client);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedResult, setSelectedResult] = useState<{
    turnId: string;
    artifactId: string;
  } | null>(null);
  const [viewport, setViewport] = useState({ sessionDrawer: false, activityDrawer: false });
  const [activityDrawerUserOpen, setActivityDrawerUserOpen] = useState(false);
  const [pendingSessionRailAction, setPendingSessionRailAction] =
    useState<SessionRailAction | null>(null);
  const [taskPreset, setTaskPreset] = useState<TaskPreset | null>(null);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const resultOverlayOpen = useRef(false);
  const sessionRailRef = useRef<HTMLElement>(null);
  const activityRef = useRef<HTMLElement>(null);
  const previousDrawerFocus = useRef<HTMLElement | null>(null);
  const {
    answerQuestions,
    archiveCurrent,
    cancel,
    createSession,
    deleteCurrent,
    dismissNotice,
    saveQuestionDraft,
    searchSessions,
    selectModel,
    selectSession,
    send,
    rerun,
    renameCurrent,
    restoreCurrent,
    setActivityOpen,
    setSessionDrawer,
  } = actions;

  const latestTurnStatus = state.current?.turns.at(-1)?.status;
  const archiveDisabled =
    state.busy ||
    ['queued', 'running', 'needs_input', 'cancelling'].includes(latestTurnStatus ?? '');

  useEffect(() => {
    const sessionQuery = window.matchMedia('(max-width: 760px)');
    const activityQuery = window.matchMedia('(max-width: 1200px)');
    const update = () =>
      setViewport({ sessionDrawer: sessionQuery.matches, activityDrawer: activityQuery.matches });
    update();
    sessionQuery.addEventListener('change', update);
    activityQuery.addEventListener('change', update);
    return () => {
      sessionQuery.removeEventListener('change', update);
      activityQuery.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (viewport.activityDrawer) {
      setActivityDrawerUserOpen(false);
      setActivityOpen(false);
    }
  }, [setActivityOpen, viewport.activityDrawer]);

  const closeDrawers = useCallback(() => {
    setSessionDrawer(false);
    if (viewport.activityDrawer) {
      setActivityDrawerUserOpen(false);
      setActivityOpen(false);
    }
  }, [setActivityOpen, setSessionDrawer, viewport.activityDrawer]);

  const sessionDrawerModal = viewport.sessionDrawer && state.sessionDrawerOpen;
  const activityDrawerModal =
    viewport.activityDrawer && state.activityOpen && activityDrawerUserOpen;
  const drawerModalOpen = sessionDrawerModal || activityDrawerModal;

  resultOverlayOpen.current = selectedResult !== null;

  useEffect(() => {
    if (!drawerModalOpen) return undefined;
    previousDrawerFocus.current = document.activeElement as HTMLElement | null;
    const container = sessionDrawerModal ? sessionRailRef.current : activityRef.current;
    const focusable = () =>
      Array.from(
        container?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute('inert'));
    (focusable()[0] ?? container)?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (resultOverlayOpen.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawers();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousDrawerFocus.current?.focus();
    };
  }, [activityDrawerModal, closeDrawers, drawerModalOpen, sessionDrawerModal]);

  const closeResult = useCallback(() => setSelectedResult(null), []);

  const handleSearch = useCallback((query: string) => void searchSessions(query), [searchSessions]);
  const chooseTaskPreset = useCallback((preset: TaskPreset) => {
    setTaskPreset(preset);
    setComposerFocusRequest((request) => request + 1);
  }, []);

  const startTask = useCallback(
    (mode: TaskPresetId) => {
      chooseTaskPreset(getTaskPreset(mode));
      closeDrawers();
    },
    [chooseTaskPreset, closeDrawers],
  );

  const applySessionRailAction = useCallback(
    (action: SessionRailAction) => {
      if (action.kind === 'rename') return renameCurrent(action.title);
      if (action.kind === 'archive') return archiveCurrent();
      return restoreCurrent();
    },
    [archiveCurrent, renameCurrent, restoreCurrent],
  );

  useEffect(() => {
    if (!pendingSessionRailAction) return;
    if (state.current?.id !== pendingSessionRailAction.sessionId) {
      if (!state.busy) void selectSession(pendingSessionRailAction.sessionId);
      return;
    }
    if (state.busy) return;
    const action = pendingSessionRailAction;
    setPendingSessionRailAction(null);
    void applySessionRailAction(action);
  }, [applySessionRailAction, pendingSessionRailAction, selectSession, state.busy, state.current?.id]);

  const requestSessionRailAction = useCallback(
    (action: SessionRailAction) => {
      if (state.current?.id === action.sessionId && !state.busy) {
        void applySessionRailAction(action);
        return;
      }
      setPendingSessionRailAction(action);
    },
    [applySessionRailAction, state.busy, state.current?.id],
  );

  return (
    <div
      className="app-shell app"
      data-activity-open={state.activityOpen}
      data-activity-modal={activityDrawerModal}
      data-session-drawer={state.sessionDrawerOpen}
    >
      <a className="skip-link" href="#main-content">
        跳到对话
      </a>

      <aside
        id="session-rail"
        ref={sessionRailRef}
        className="session-rail left-sidebar"
        aria-label="会话导航"
        aria-hidden={viewport.sessionDrawer && !state.sessionDrawerOpen}
        aria-modal={sessionDrawerModal || undefined}
        role={sessionDrawerModal ? 'dialog' : undefined}
        tabIndex={-1}
        inert={viewport.sessionDrawer && !state.sessionDrawerOpen ? true : undefined}
      >
        <SessionRail
          sessions={state.sessions}
          archivedSessions={state.archivedSessions}
          {...(state.current ? { currentId: state.current.id } : {})}
          currentArchived={state.current?.archived ?? false}
          busy={state.busy}
          archiveDisabled={archiveDisabled}
          onCreate={() => {
            setTaskPreset(null);
            void createSession();
            closeDrawers();
          }}
          onSelect={(id) => {
            setTaskPreset(null);
            void selectSession(id);
            closeDrawers();
          }}
          onSearch={handleSearch}
          onTaskSelect={startTask}
          onRename={(sessionId, title) =>
            requestSessionRailAction({ kind: 'rename', sessionId, title })
          }
          onArchive={(sessionId) => {
            if (sessionId) requestSessionRailAction({ kind: 'archive', sessionId });
          }}
          onRestore={(sessionId) => {
            if (sessionId) requestSessionRailAction({ kind: 'restore', sessionId });
          }}
          onDelete={() => setDeleteOpen(true)}
        />
      </aside>

      <section className="workspace-frame chat-column" inert={drawerModalOpen ? true : undefined}>
        <WorkspaceHeader
          session={state.current}
          busy={state.busy}
          activityOpen={state.activityOpen}
          sessionDrawerOpen={state.sessionDrawerOpen}
          onRename={renameCurrent}
          onRestore={() => void restoreCurrent()}
          onOpenSessions={() => setSessionDrawer(true)}
          onToggleActivity={() => {
            const nextOpen = !state.activityOpen;
            setActivityDrawerUserOpen(viewport.activityDrawer && nextOpen);
            setActivityOpen(nextOpen);
          }}
        />

        {state.notice && (
          <div className="notice-banner" role="alert">
            <AlertCircle size={18} aria-hidden="true" />
            <div>
              <strong>{state.notice.title}</strong>
              <p>{state.notice.detail}</p>
              {state.notice.recovery && <small>{state.notice.recovery}</small>}
              {state.notice.correlationId && <code>关联 ID：{state.notice.correlationId}</code>}
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={dismissNotice}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <ConversationWorkspace
          session={state.current}
          busy={state.busy || state.loading}
          hasModel={state.models.some((model) => model.available)}
          models={state.models}
          selectedModel={state.selectedModel}
          selectedReasoning={state.selectedReasoning}
          modelLocked={state.current?.modelLocked ?? false}
          onModelChange={selectModel}
          onSend={(content, files, reuseAvailableData) =>
            void send(content, files, reuseAvailableData)
          }
          onCancel={() => void cancel()}
          onAnswer={(questionSetId, answers) => {
            const questionSet = state.current?.activeQuestionSet;
            if (questionSet?.id === questionSetId) void answerQuestions(questionSet, answers);
          }}
          onSaveDraft={(questionSetId, draft) => saveQuestionDraft(questionSetId, draft)}
          onOpenResult={(turnId, artifactId) => setSelectedResult({ turnId, artifactId })}
          onRerun={(turnId) => void rerun(turnId)}
          taskPreset={taskPreset}
          composerFocusRequest={composerFocusRequest}
          onTaskPreset={chooseTaskPreset}
          onRemoveTaskPreset={() => setTaskPreset(null)}
        />
      </section>

      <aside
        id="activity-inspector"
        ref={activityRef}
        className="activity-inspector right-sidebar"
        aria-label="业务上下文"
        aria-hidden={!state.activityOpen}
        aria-modal={activityDrawerModal || undefined}
        role={activityDrawerModal ? 'dialog' : undefined}
        tabIndex={-1}
        inert={!state.activityOpen ? true : undefined}
      >
        <ActivityInspector
          session={state.current}
          busy={state.busy || state.loading}
          onCancel={() => void cancel()}
          onOpenResult={(turnId, artifactId) => setSelectedResult({ turnId, artifactId })}
        />
      </aside>

      {(state.sessionDrawerOpen || state.activityOpen) && (
        <button
          className="drawer-scrim"
          type="button"
          aria-label="关闭侧栏"
          onClick={closeDrawers}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="删除当前会话？"
        confirmLabel="确认删除"
        busy={state.busy}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          void deleteCurrent().then(() => setDeleteOpen(false));
        }}
      >
        <p>这会停止活动执行，并删除应用保存的消息、上传快照、事件和 Artifact。</p>
        <p>Codex 主机私有 thread 文件不属于本应用删除范围，删除后本应用不再提供恢复入口。</p>
      </ConfirmDialog>

      {selectedResult && state.current && (
        <ResultDetailsPanel
          session={state.current}
          turnId={selectedResult.turnId}
          artifactId={selectedResult.artifactId}
          onClose={closeResult}
        />
      )}
    </div>
  );
}
