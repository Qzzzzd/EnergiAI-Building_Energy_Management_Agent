import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail, TurnStatus } from '../domain';
import { ConversationWorkspace } from './ConversationWorkspace';

afterEach(cleanup);

function session(status: TurnStatus): SessionDetail {
  const now = '2026-08-10T01:00:00.000Z';
  const sessionStatus = status === 'queued' || status === 'cancelling' ? 'running' : status;
  return {
    id: 'session-1',
    title: '运行控制',
    status: sessionStatus,
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    modelLocked: true,
    archived: false,
    updatedAt: now,
    preview: '',
    createdAt: now,
    lastEventId: 2,
    skillJobs: [],
    turns: [
      {
        id: 'turn-1',
        status,
        startedAt: now,
        messages: [],
        activities: [],
        results: [],
      },
    ],
    uploads: [],
    artifacts: [],
    disclosure: '本地删除边界说明',
  };
}

describe('ConversationWorkspace task entry and cancellation', () => {
  it('preloads a task intent without sending a turn', () => {
    const onSend = vi.fn();
    const onTaskPreset = vi.fn();
    render(
      <ConversationWorkspace
        session={null}
        busy={false}
        hasModel
        onSend={onSend}
        onCancel={vi.fn()}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
        onTaskPreset={onTaskPreset}
      />,
    );

    expect(screen.getByLabelText('业务任务入口').querySelectorAll('.task-entry-card')).toHaveLength(
      3,
    );
    fireEvent.click(screen.getByRole('button', { name: /质量评估 \+ 负荷预测/ }));
    expect(onTaskPreset).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'integrated', title: '质量评估 + 负荷预测' }),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders real upload snapshots attached to a user message', () => {
    const current = session('completed');
    const turn = current.turns[0];
    if (!turn) throw new Error('test turn missing');
    turn.messages = [
      {
        id: 'message-1',
        turnId: 'turn-1',
        role: 'user',
        content: '检查这份数据',
        createdAt: current.updatedAt,
        sourceRefs: ['source-1'],
      },
    ];
    current.uploads = [
      {
        id: 'source-1',
        sourceRef: 'source-1',
        name: '冷站数据.xlsx',
        sizeBytes: 1_024,
        sha256: 'a'.repeat(64),
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ];

    render(
      <ConversationWorkspace
        session={current}
        busy={false}
        hasModel
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
      />,
    );

    const attachments = screen.getByLabelText('消息附件');
    expect(attachments).toBeVisible();
    expect(attachments).toHaveClass('message-files');
    expect(within(attachments).getByText('冷站数据.xlsx')).toBeVisible();
    expect(within(attachments).getByText('1.0 KB')).toBeVisible();
  });

  it('offers cancellation only while the turn is running and disables the composer', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConversationWorkspace
        session={session('running')}
        busy={false}
        hasModel
        onSend={vi.fn()}
        onCancel={onCancel}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '停止回复' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('输入建筑能源分析需求')).toBeDisabled();

    rerender(
      <ConversationWorkspace
        session={session('cancelled')}
        busy={false}
        hasModel
        onSend={vi.fn()}
        onCancel={onCancel}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '停止回复' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('输入建筑能源分析需求')).toBeEnabled();
  });

  it('does not treat an answered historical needs-input turn as the active turn', () => {
    const resumed = session('needs_input');
    resumed.status = 'completed';
    resumed.turns.push({
      id: 'turn-2',
      status: 'completed',
      startedAt: resumed.updatedAt,
      messages: [],
      activities: [],
      results: [],
    });

    render(
      <ConversationWorkspace
        session={resumed}
        busy={false}
        hasModel
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('输入建筑能源分析需求')).toBeEnabled();
    expect(screen.queryByText(/问题组尚未恢复/)).not.toBeInTheDocument();
  });

  it('keeps an archived conversation readable but prevents new work until it is restored', () => {
    const archived = session('completed');
    archived.archived = true;
    render(
      <ConversationWorkspace
        session={archived}
        busy={false}
        hasModel
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onAnswer={vi.fn()}
        onSaveDraft={vi.fn()}
      />,
    );

    expect(screen.getByText('该会话已归档')).toBeVisible();
    expect(screen.getByLabelText('输入建筑能源分析需求')).toBeDisabled();
  });
});
