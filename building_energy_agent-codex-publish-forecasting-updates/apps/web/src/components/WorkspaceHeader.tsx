import {
  Activity,
  Check,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  RotateCcw,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionDetail } from '../domain';
import { StatusMark } from '../ui/StatusMark';

interface WorkspaceHeaderProps {
  session: SessionDetail | null;
  busy?: boolean;
  activityOpen: boolean;
  sessionDrawerOpen: boolean;
  onRename(title: string): Promise<void>;
  onRestore(): void;
  onOpenSessions(): void;
  onToggleActivity(): void;
}

export function WorkspaceHeader({
  session,
  busy = false,
  activityOpen,
  sessionDrawerOpen,
  onRename,
  onRestore,
  onOpenSessions,
  onToggleActivity,
}: WorkspaceHeaderProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session?.title ?? '');
  const [savingTitle, setSavingTitle] = useState(false);

  useEffect(() => {
    setTitleDraft(session?.title ?? '');
    setEditingTitle(false);
  }, [session?.id, session?.title]);

  const saveTitle = async () => {
    const title = titleDraft.trim();
    if (!session || !title || title === session.title) {
      setEditingTitle(false);
      setTitleDraft(session?.title ?? '');
      return;
    }
    setSavingTitle(true);
    try {
      await onRename(title);
      setEditingTitle(false);
    } finally {
      setSavingTitle(false);
    }
  };

  return (
    <header className="workspace-header chat-header">
      <button
        type="button"
        className="icon-button mobile-only"
        aria-label="打开会话列表"
        aria-controls="session-rail"
        aria-expanded={sessionDrawerOpen}
        onClick={onOpenSessions}
      >
        <Menu size={19} />
      </button>

      <div className="session-heading chat-heading">
        {editingTitle && session ? (
          <form
            className="session-title-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <label className="sr-only" htmlFor="session-title-input">
              会话名称
            </label>
            <input
              id="session-title-input"
              value={titleDraft}
              maxLength={200}
              autoFocus
              disabled={savingTitle}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setTitleDraft(session.title);
                  setEditingTitle(false);
                }
              }}
            />
            <button
              className="icon-button session-title-save"
              type="submit"
              aria-label="保存会话名称"
              disabled={savingTitle || !titleDraft.trim()}
            >
              <Check size={15} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="取消重命名"
              disabled={savingTitle}
              onClick={() => {
                setTitleDraft(session.title);
                setEditingTitle(false);
              }}
            >
              <X size={15} />
            </button>
          </form>
        ) : (
          <div className="session-title-display">
            <strong title={session?.title || '新会话'}>{session?.title || '新会话'}</strong>
            {session && (
              <button
                className="icon-button session-title-edit"
                type="button"
                aria-label="重命名当前会话"
                title="重命名当前会话"
                onClick={() => setEditingTitle(true)}
              >
                <PencilLine size={14} />
              </button>
            )}
            {session?.archived && <span className="session-archive-state">已归档</span>}
          </div>
        )}
      </div>

      {session && <StatusMark status={session.status} />}

      {session?.archived && (
        <button
          type="button"
          className="restore-session-action"
          aria-label="恢复会话"
          disabled={busy}
          onClick={onRestore}
        >
          <RotateCcw size={15} aria-hidden="true" />
          <span>恢复会话</span>
        </button>
      )}

      <button
        type="button"
        className="activity-toggle"
        aria-label={activityOpen ? '收起业务上下文' : '打开业务上下文'}
        aria-expanded={activityOpen}
        aria-controls="activity-inspector"
        onClick={onToggleActivity}
      >
        <Activity size={17} aria-hidden="true" />
        <span>业务上下文</span>
        {activityOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
    </header>
  );
}
