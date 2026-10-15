import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionSet } from '../domain';
import { QuestionGroup } from './QuestionGroup';

const questionSet: QuestionSet = {
  id: 'questions-1',
  turnId: 'turn-1',
  status: 'pending',
  questions: [
    {
      id: 'timezone',
      question: '源数据使用哪个时区？',
      options: ['Asia/Shanghai', 'UTC'],
      allowFreeText: false,
      required: true,
    },
    {
      id: 'target',
      question: '请选择目标点位',
      options: ['冷机总功率'],
      allowFreeText: true,
      required: true,
    },
  ],
  draft: { timezone: 'Asia/Shanghai' },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('QuestionGroup', () => {
  it('restores drafts, autosaves the complete group, and submits all answers together', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onSubmit = vi.fn();
    const { container } = render(
      <QuestionGroup questionSet={questionSet} busy={false} onSave={onSave} onSubmit={onSubmit} />,
    );

    expect(screen.getByRole('heading', { name: /^需要确认$/ })).toBeVisible();
    expect(screen.getByText('第 2 / 2 项', { exact: true })).toBeVisible();
    expect(screen.getByText('请选择目标点位')).toBeVisible();
    expect(screen.queryByText('源数据使用哪个时区？')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交并继续' })).toBeDisabled();
    const targetField = screen.getByText('请选择目标点位').closest('fieldset');
    expect(targetField).not.toBeNull();
    fireEvent.click(targetField!.querySelector<HTMLInputElement>('input[value="free"]')!);
    fireEvent.change(screen.getByLabelText('你的回答'), { target: { value: ' 冷站总表 ' } });

    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenLastCalledWith({
      timezone: 'Asia/Shanghai',
      target: 'free: 冷站总表 ',
    });
    expect(container).toHaveTextContent('草稿已保存');

    fireEvent.click(screen.getByRole('button', { name: /^上一项$/ }));
    expect(screen.getByText('第 1 / 2 项', { exact: true })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Asia/Shanghai' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^下一项$/ }));
    expect(screen.getByLabelText('你的回答')).toHaveValue(' 冷站总表 ');

    fireEvent.change(screen.getByLabelText('你的回答'), { target: { value: ' 冷站主表 ' } });
    expect(container).toHaveTextContent('草稿自动保存');
    await act(async () => vi.advanceTimersByTime(500));
    expect(onSave).toHaveBeenLastCalledWith({
      timezone: 'Asia/Shanghai',
      target: 'free: 冷站主表 ',
    });
    expect(container).toHaveTextContent('草稿已保存');

    fireEvent.click(screen.getByRole('button', { name: '提交并继续' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      timezone: 'Asia/Shanghai',
      target: '冷站主表',
    });
  });

  it('does not autosave the server-restored draft on initial render', () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    render(
      <QuestionGroup
        questionSet={questionSet}
        busy={false}
        onSave={onSave.mockResolvedValue(undefined)}
        onSubmit={vi.fn()}
      />,
    );

    act(() => vi.advanceTimersByTime(1_000));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('keeps a locally saved answer when the same question set rerenders with an older draft', async () => {
    vi.useFakeTimers();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const pendingQuestionSet = { ...questionSet, draft: {} };
    const { rerender } = render(
      <QuestionGroup
        questionSet={pendingQuestionSet}
        busy={false}
        onSave={onSave}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Asia/Shanghai' }));
    await act(async () => vi.advanceTimersByTime(500));
    rerender(
      <QuestionGroup
        questionSet={{ ...pendingQuestionSet, draft: {} }}
        busy={false}
        onSave={onSave}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole('radio', { name: 'Asia/Shanghai' })).toBeChecked();
    expect(screen.getByRole('button', { name: '下一项' })).toBeEnabled();
  });

  it('does not claim a failed draft write was saved', async () => {
    vi.useFakeTimers();
    render(
      <QuestionGroup
        questionSet={questionSet}
        busy={false}
        onSave={vi.fn().mockRejectedValue(new Error('offline'))}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('冷机总功率'));
    await act(async () => vi.advanceTimersByTime(500));
    expect(screen.getByText('草稿未保存')).toBeVisible();
  });
});
