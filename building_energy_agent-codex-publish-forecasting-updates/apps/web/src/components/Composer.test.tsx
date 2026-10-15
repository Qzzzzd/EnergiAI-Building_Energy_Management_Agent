import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '../domain';
import { Composer } from './Composer';

const mib = 1024 * 1024;

function file(name: string, size = 16): File {
  const value = new File(['building-energy'], name);
  Object.defineProperty(value, 'size', { configurable: true, value: size });
  return value;
}

afterEach(cleanup);

function choose(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('file input not rendered');
  fireEvent.change(input, { target: { files } });
}

const models: ModelOption[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    reasoningLevels: ['high', 'xhigh'],
    available: true,
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    reasoningLevels: ['low', 'medium'],
    available: true,
  },
  {
    id: 'gpt-5.6-legacy',
    displayName: 'GPT-5.6 Legacy',
    reasoningLevels: ['medium'],
    available: false,
  },
];

describe('Composer upload boundaries', () => {
  it('rejects unsupported extensions before invoking send', () => {
    const onSend = vi.fn();
    const { container } = render(<Composer busy={false} onSend={onSend} />);

    choose(container, [file('meter.txt')]);

    expect(screen.getByText('meter.txt 不是支持的 XLSX、XLSM 或 CSV 文件。')).toBeVisible();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('rejects more than ten files, an oversized file, and an oversized aggregate', () => {
    const { container } = render(<Composer busy={false} onSend={vi.fn()} />);

    choose(
      container,
      Array.from({ length: 11 }, (_, index) => file(`meter-${index}.csv`)),
    );
    expect(screen.getByText('一次最多选择 10 个文件。')).toBeVisible();

    choose(container, [file('oversized.xlsx', 200 * mib + 1)]);
    expect(screen.getByText('oversized.xlsx 超过单文件 200 MB 限制。')).toBeVisible();

    choose(container, [file('a.csv', 101 * mib), file('b.csv', 100 * mib)]);
    expect(screen.getByText('所选文件总量超过 200 MB 限制。')).toBeVisible();
  });

  it('submits trimmed text with the accepted batch and clears the queue', () => {
    const onSend = vi.fn();
    const { container } = render(<Composer busy={false} onSend={onSend} />);
    const workbook = file('meter.xlsx', 1_024);

    choose(container, [workbook]);
    fireEvent.change(screen.getByLabelText('输入建筑能源分析需求'), {
      target: { value: '  评估数据质量  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(onSend).toHaveBeenCalledWith('评估数据质量', [workbook], false);
    expect(screen.queryByRole('list', { name: '待上传文件' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('输入建筑能源分析需求')).toHaveValue('');
  });

  it('appends a second accepted batch to the upload queue', () => {
    const onSend = vi.fn();
    const { container } = render(<Composer busy={false} onSend={onSend} />);
    const first = file('first.csv', 1_024);
    const second = file('second.xlsx', 2_048);

    choose(container, [first]);
    choose(container, [second]);

    expect(screen.getByRole('list', { name: '待上传文件' })).toHaveTextContent('first.csv');
    expect(screen.getByRole('list', { name: '待上传文件' })).toHaveTextContent('second.xlsx');
    fireEvent.change(screen.getByLabelText('输入建筑能源分析需求'), {
      target: { value: '检查文件' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(onSend).toHaveBeenCalledWith('检查文件', [first, second], false);
  });

  it('keeps Shift+Enter and composing Enter from sending, and closes the model menu on Escape', () => {
    const onSend = vi.fn();
    render(
      <Composer
        busy={false}
        models={models}
        selectedModel="gpt-5.6-sol"
        selectedReasoning="xhigh"
        onModelChange={vi.fn()}
        onSend={onSend}
      />,
    );

    const input = screen.getByLabelText('输入建筑能源分析需求');
    fireEvent.change(input, { target: { value: '继续输入' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('继续输入');

    fireEvent.click(screen.getByRole('button', { name: /模型设置：GPT-5.6 Sol · 很高/ }));
    expect(screen.getByRole('menu', { name: '模型与推理设置' })).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: '模型与推理设置' })).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('继续输入', [], false);
  });

  it('opens compact model settings and adapts reasoning to the selected model', () => {
    const onModelChange = vi.fn();
    const { rerender } = render(
      <Composer
        busy={false}
        models={models}
        selectedModel="gpt-5.6-sol"
        selectedReasoning="xhigh"
        onModelChange={onModelChange}
        onSend={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /模型设置：GPT-5.6 Sol · 很高/ });
    expect(trigger.closest('.composer-actions')).not.toBeNull();
    expect(screen.queryByRole('menu', { name: '模型与推理设置' })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: '模型与推理设置' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: 'GPT-5.6 Terra' })).toBeVisible();
    expect(screen.getByRole('menuitemradio', { name: 'GPT-5.6 Legacy' })).toBeDisabled();

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-5.6 Terra' }));
    expect(onModelChange).toHaveBeenLastCalledWith('gpt-5.6-terra', 'low');

    rerender(
      <Composer
        busy={false}
        models={models}
        selectedModel="gpt-5.6-terra"
        selectedReasoning="low"
        onModelChange={onModelChange}
        onSend={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /模型设置：GPT-5.6 Terra · 低/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '中等' }));
    expect(onModelChange).toHaveBeenLastCalledWith('gpt-5.6-terra', 'medium');
  });

  it('keeps the selected model visible with a lock after the first turn', () => {
    render(
      <Composer
        busy={false}
        models={models}
        selectedModel="gpt-5.6-sol"
        selectedReasoning="xhigh"
        modelLocked
        onModelChange={vi.fn()}
        onSend={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: /模型设置：GPT-5.6 Sol · 很高（已固定）/ });
    expect(trigger).toBeDisabled();
    expect(screen.queryByRole('menu', { name: '模型与推理设置' })).not.toBeInTheDocument();
    expect(screen.queryByText('首轮发送后锁定')).not.toBeInTheDocument();
    expect(screen.getByLabelText('输入建筑能源分析需求')).toBeEnabled();
  });

  it('shows a removable task intent and sends it only after explicit submit', () => {
    const onSend = vi.fn();
    const onRemoveIntent = vi.fn();
    const { container } = render(
      <Composer
        busy={false}
        intent={{
          id: 'quality',
          title: '数据质量评估',
          description: '检查缺口、异常与六维质量风险',
          prompt: '请检查数据质量。',
        }}
        onRemoveIntent={onRemoveIntent}
        onSend={onSend}
      />,
    );
    const workbook = file('meter.xlsx', 1_024);

    expect(screen.getByText('分析任务 · 数据质量评估')).toBeVisible();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeEnabled();
    expect(onSend).not.toHaveBeenCalled();
    choose(container, [workbook]);
    fireEvent.change(screen.getByLabelText('输入建筑能源分析需求'), {
      target: { value: '只看工作日数据' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(onSend).toHaveBeenCalledWith(
      '请检查数据质量。\n\n补充要求：只看工作日数据',
      [workbook],
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '移除数据质量评估意图' }));
    expect(onRemoveIntent).toHaveBeenCalledTimes(2);
  });
});
