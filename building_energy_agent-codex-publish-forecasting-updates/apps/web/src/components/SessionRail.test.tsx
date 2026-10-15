import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../domain';
import { SessionRail } from './SessionRail';

afterEach(cleanup);

const now = '2026-08-11T01:00:00.000Z';

function summary(input: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'active-session',
    title: '当前负荷预测',
    status: 'completed',
    model: 'gpt-5.6-sol',
    reasoning: 'xhigh',
    modelLocked: true,
    archived: false,
    updatedAt: now,
    preview: '预测未来 24 小时负荷',
    ...input,
  };
}

function renderRail(input: Partial<React.ComponentProps<typeof SessionRail>> = {}) {
  const handlers = {
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    onSearch: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    onTaskSelect: vi.fn(),
  };
  render(
    <SessionRail
      sessions={[summary()]}
      archivedSessions={[
        summary({
          id: 'archived-session',
          title: '已归档质量评估',
          archived: true,
          preview: '已检查数据质量风险',
        }),
      ]}
      currentId="active-session"
      currentArchived={false}
      busy={false}
      archiveDisabled={false}
      {...handlers}
      {...input}
    />,
  );
  return handlers;
}

describe('SessionRail business navigation', () => {
  it('keeps task entry points and separates archived history from recent conversations', () => {
    const handlers = renderRail();

    expect(screen.getByRole('button', { name: '新建会话' })).toBeVisible();
    expect(screen.getByRole('button', { name: '负荷预测' })).toBeVisible();
    expect(screen.getByRole('button', { name: '数据质量评估' })).toBeVisible();
    expect(screen.getByText('当前负荷预测')).toBeVisible();
    expect(screen.queryByText('已归档质量评估')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '负荷预测' }));
    expect(handlers.onTaskSelect).toHaveBeenCalledWith('forecast');

    fireEvent.click(screen.getByRole('button', { name: /历史记录/ }));
    expect(screen.getByText('已归档质量评估')).toBeVisible();
  });

  it('uses recoverable archive and restore actions for the selected session', () => {
    const active = renderRail();
    fireEvent.click(screen.getByRole('button', { name: '归档当前会话' }));
    expect(active.onArchive).toHaveBeenCalledTimes(1);

    const archived = renderRail({
      currentId: 'archived-session',
      currentArchived: true,
    });
    fireEvent.click(screen.getByRole('button', { name: '恢复当前会话' }));
    expect(archived.onRestore).toHaveBeenCalledTimes(1);
  });
});
