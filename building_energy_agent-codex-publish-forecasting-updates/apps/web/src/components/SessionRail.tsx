import {
  Archive,
  BarChart3,
  Bot,
  ChevronDown,
  ClipboardCheck,
  History,
  Layers3,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SessionSummary } from '../domain';
import { formatWhen } from '../ui/format';
import { StatusMark } from '../ui/StatusMark';
import { taskPresets, type TaskPresetId } from './taskPresets';

interface SessionRailProps {
  sessions: SessionSummary[];
  archivedSessions: SessionSummary[];
  currentId?: string;
  currentArchived: boolean;
  busy: boolean;
  archiveDisabled: boolean;
  onCreate(): void;
  onSelect(sessionId: string): void;
  onSearch(query: string): void;
  onArchive(sessionId?: string): void;
  onRestore(sessionId?: string): void;
  onRename?(sessionId: string, title: string): void;
  onDelete(): void;
  onTaskSelect(mode: TaskPresetId): void;
}

export function SessionRail({
  sessions,
  archivedSessions,
  currentId,
  currentArchived,
  busy,
  archiveDisabled,
  onCreate,
  onSelect,
  onSearch,
  onArchive,
  onRestore,
  onRename,
  onDelete,
  onTaskSelect,
}: SessionRailProps) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const visibleSessions = (showArchived ? archivedSessions : sessions).filter((session) =>
    `${session.title} ${session.preview}`.toLocaleLowerCase().includes(needle),
  );

  useEffect(() => {
    const timer = window.setTimeout(() => onSearch(query), 220);
    return () => window.clearTimeout(timer);
  }, [onSearch, query]);

  useEffect(() => {
    if (currentArchived) setShowArchived(true);
  }, [currentArchived]);

  useEffect(() => {
    if (!openMenuId) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpenMenuId(null);
      setMenuPosition(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [openMenuId]);

  const setArchiveView = (archived: boolean) => {
    setShowArchived(archived);
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  const startRename = (session: SessionSummary) => {
    setDraftTitle(session.title);
    setRenamingId(session.id);
    setOpenMenuId(null);
    setMenuPosition(null);
  };

  return (
    <div className="left-panel-content session-rail-content">
      <div className="side-brand product-lockup">
        <span className="side-brand-mark product-mark" aria-hidden="true">
          E
        </span>
        <span>
          <strong>EnergiAI</strong>
          <small>建筑能源专业智能体</small>
        </span>
      </div>

      <button
        className="new-chat-button primary-action rail-new"
        type="button"
        aria-label="新建会话"
        onClick={onCreate}
        disabled={busy}
      >
        <MessageSquarePlus size={18} aria-hidden="true" />
        新建对话
      </button>

      <nav className="task-nav" aria-label="对话模式">
        <span className="nav-section-label">对话</span>
        <button className="active" type="button" onClick={onCreate} disabled={busy}>
          <Bot size={18} aria-hidden="true" />
          <span>
            <strong>普通对话</strong>
          </span>
        </button>
      </nav>

      <nav className="task-nav" aria-label="专业技能">
        <span className="nav-section-label">专业技能</span>
        {taskPresets.map((task) => {
          const Icon = task.id === 'forecast' ? BarChart3 : task.id === 'quality' ? ClipboardCheck : Layers3;
          return (
            <button
              key={task.id}
              type="button"
              aria-label={task.title}
              disabled={busy}
              onClick={() => onTaskSelect(task.id)}
            >
              <Icon size={18} aria-hidden="true" />
              <span>
                <strong>{task.title}</strong>
              </span>
            </button>
          );
        })}
      </nav>

      <label className="session-search">
        <span className="sr-only">搜索会话</span>
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          placeholder="搜索会话…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <div className="session-view-tabs" aria-label="会话范围">
        <button
          type="button"
          className={!showArchived ? 'active' : ''}
          aria-pressed={!showArchived}
          onClick={() => setArchiveView(false)}
        >
          <History size={13} aria-hidden="true" />
          最近对话
        </button>
        <button
          type="button"
          className={showArchived ? 'active' : ''}
          aria-pressed={showArchived}
          aria-label="历史记录"
          onClick={() => setArchiveView(true)}
        >
          <Archive size={13} aria-hidden="true" />
          已归档
          <span aria-label={`共 ${archivedSessions.length} 个已归档对话`}>{archivedSessions.length}</span>
        </button>
      </div>

      <nav
        id="session-list"
        className={`session-nav ${showArchived ? 'session-nav-archived' : 'session-nav-recent'}`}
        aria-label={showArchived ? '已归档对话' : '最近对话'}
      >
        <div className="session-list-heading">
          <span className="session-list-title">
            {showArchived ? <Archive size={14} aria-hidden="true" /> : <History size={14} aria-hidden="true" />}
            <span className="nav-section-label">{showArchived ? '已归档对话' : '最近对话'}</span>
          </span>
          <button type="button" className="session-view-reset" onClick={() => setArchiveView(!showArchived)}>
            {showArchived ? '返回最近' : '查看归档'}
          </button>
        </div>

        {visibleSessions.map((session) => (
          <div className="session-item" key={session.id}>
            {renamingId === session.id ? (
              <form
                className="session-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  const title = draftTitle.trim();
                  if (!title) return;
                  onRename?.(session.id, title);
                  setRenamingId(null);
                }}
              >
                <label className="sr-only" htmlFor={`rename-${session.id}`}>
                  新的会话名称
                </label>
                <input
                  id={`rename-${session.id}`}
                  value={draftTitle}
                  maxLength={200}
                  autoFocus
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return;
                    event.preventDefault();
                    setRenamingId(null);
                  }}
                />
                <button type="submit">保存</button>
                <button type="button" onClick={() => setRenamingId(null)}>
                  取消
                </button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className={`session-select ${session.id === currentId ? 'active' : ''}`}
                  aria-current={session.id === currentId ? 'page' : undefined}
                  onClick={() => {
                    setOpenMenuId(null);
                    setMenuPosition(null);
                    onSelect(session.id);
                  }}
                >
                  <span>{session.title || '未命名会话'}</span>
                  <small>{formatWhen(session.updatedAt)}</small>
                  {(session.preview || session.archived) && (
                    <small className="session-preview">
                      {session.preview || '已归档，可恢复后继续分析'}
                    </small>
                  )}
                </button>
                <button
                  type="button"
                  className="session-more"
                  aria-label={`${session.title || '未命名会话'} 的操作`}
                  aria-expanded={openMenuId === session.id}
                  onClick={(event) => {
                    if (openMenuId === session.id) {
                      setOpenMenuId(null);
                      setMenuPosition(null);
                      return;
                    }
                    const rect = event.currentTarget.getBoundingClientRect();
                    setOpenMenuId(session.id);
                    setMenuPosition({ top: rect.top + rect.height / 2, left: rect.right - 2 });
                  }}
                >
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
                {openMenuId === session.id && (
                  <div className="session-menu" style={menuPosition ?? undefined} role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      aria-label="重命名"
                      data-tooltip="重命名"
                      onClick={() => startRename(session)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                    {showArchived ? (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="恢复"
                        data-tooltip="恢复"
                        onClick={() => {
                          onRestore(session.id);
                          setOpenMenuId(null);
                          setMenuPosition(null);
                        }}
                      >
                        <Undo2 size={15} aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        aria-label="归档"
                        data-tooltip={
                          session.status === 'running' ||
                          session.status === 'needs_input' ||
                          session.status === 'deleting'
                            ? '运行中的会话不能归档'
                            : '归档'
                        }
                        disabled={
                          session.status === 'running' ||
                          session.status === 'needs_input' ||
                          session.status === 'deleting'
                        }
                        onClick={() => {
                          onArchive(session.id);
                          setOpenMenuId(null);
                          setMenuPosition(null);
                        }}
                      >
                        <Archive size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {visibleSessions.length === 0 && (
          <span className="session-empty">{needle ? '没有匹配的会话' : '还没有会话。新建对话后即可开始分析。'}</span>
        )}
      </nav>

      <div className="left-footer rail-footer">
        <span className="api-mode api-mode-local">
          <span aria-hidden="true" />
          本地工作区
        </span>
        <small>真实运行时 · 可验证结果</small>
        <div className="rail-session-actions">
          {currentArchived ? (
            <button
              className="icon-button rail-restore-action"
              type="button"
              aria-label="恢复当前会话"
              title="恢复当前会话"
              disabled={!currentId || busy}
              onClick={() => onRestore(currentId)}
            >
              <Undo2 size={16} />
            </button>
          ) : (
            <button
              className="icon-button rail-archive-action"
              type="button"
              aria-label="归档当前会话"
              title="归档当前会话"
              disabled={!currentId || busy || archiveDisabled}
              onClick={() => onArchive(currentId)}
            >
              <Archive size={16} />
            </button>
          )}
          <button
            className="icon-button"
            type="button"
            aria-label="删除当前会话"
            title="删除当前会话"
            disabled={!currentId || busy}
            onClick={onDelete}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
