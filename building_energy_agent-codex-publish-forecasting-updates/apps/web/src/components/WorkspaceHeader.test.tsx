import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '../domain';
import { WorkspaceHeader } from './WorkspaceHeader';

afterEach(cleanup);

function session(modelLocked: boolean, archived = false): SessionDetail {
  return {
    id: 'session-1',
    title: '负荷预测',
    status: modelLocked ? 'completed' : 'idle',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    modelLocked,
    archived,
    updatedAt: '2026-08-10T01:00:00.000Z',
    preview: '',
    createdAt: '2026-08-10T01:00:00.000Z',
    lastEventId: 0,
    skillJobs: [],
    turns: [],
    uploads: [],
    artifacts: [],
    disclosure: '本地删除边界说明',
  };
}

function renderHeader(modelLocked: boolean) {
  render(
    <WorkspaceHeader
      session={session(modelLocked)}
      activityOpen
      sessionDrawerOpen={false}
      onRename={vi.fn().mockResolvedValue(undefined)}
      onRestore={vi.fn()}
      onOpenSessions={vi.fn()}
      onToggleActivity={vi.fn()}
    />,
  );
}

describe('WorkspaceHeader business context', () => {
  it('keeps model controls out of the default business header', () => {
    renderHeader(true);

    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.getByText('负荷预测')).toBeVisible();
  });

  it('still exposes the activity context toggle', () => {
    const onOpenSessions = vi.fn();
    render(
      <WorkspaceHeader
        session={session(false)}
        activityOpen={false}
        sessionDrawerOpen={false}
        onRename={vi.fn().mockResolvedValue(undefined)}
        onRestore={vi.fn()}
        onOpenSessions={onOpenSessions}
        onToggleActivity={onOpenSessions}
      />,
    );

    expect(screen.getByRole('button', { name: '打开业务上下文' })).toBeVisible();
  });

  it('renames the current session and exposes a restore action for archived work', async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    const onRestore = vi.fn();
    render(
      <WorkspaceHeader
        session={session(true, true)}
        activityOpen
        sessionDrawerOpen={false}
        onRename={onRename}
        onRestore={onRestore}
        onOpenSessions={vi.fn()}
        onToggleActivity={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '重命名当前会话' }));
    fireEvent.change(screen.getByRole('textbox', { name: '会话名称' }), {
      target: { value: '八月负荷预测' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存会话名称' }));

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('八月负荷预测'));
    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
