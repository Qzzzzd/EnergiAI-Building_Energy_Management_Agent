import {
  Check,
  ChevronDown,
  FileSpreadsheet,
  LockKeyhole,
  Paperclip,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ModelOption, ReasoningLevel } from '../domain';
import { formatBytes } from '../ui/format';
import type { TaskPreset } from './taskPresets';

const maxFiles = 10;
const maxBytes = 200 * 1024 * 1024;
const allowedExtensions = new Set(['xlsx', 'xlsm', 'csv']);
const reasoningLabels: Record<ReasoningLevel, string> = {
  minimal: '最小',
  low: '低',
  medium: '中等',
  high: '高',
  xhigh: '很高',
  max: '最大',
  ultra: '极高',
};

function validateFiles(files: File[]): string | null {
  if (files.length > maxFiles) return `一次最多选择 ${maxFiles} 个文件。`;
  const unsupported = files.find((file) => {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    return !allowedExtensions.has(extension);
  });
  if (unsupported) return `${unsupported.name} 不是支持的 XLSX、XLSM 或 CSV 文件。`;
  const oversized = files.find((file) => file.size > maxBytes);
  if (oversized) return `${oversized.name} 超过单文件 200 MB 限制。`;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxBytes) return '所选文件总量超过 200 MB 限制。';
  return null;
}

interface ComposerProps {
  busy: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  hasAvailableData?: boolean;
  models?: ModelOption[];
  selectedModel?: string;
  selectedReasoning?: ReasoningLevel;
  modelLocked?: boolean;
  onModelChange?(model: string, reasoning: ReasoningLevel): void;
  intent?: TaskPreset | null;
  focusRequest?: number;
  onRemoveIntent?(): void;
  onSend(content: string, files: File[], reuseAvailableData?: boolean): void;
}

export function Composer({
  busy,
  disabled = false,
  disabledMessage,
  hasAvailableData = false,
  models = [],
  selectedModel = '',
  selectedReasoning = 'xhigh',
  modelLocked = false,
  onModelChange,
  intent = null,
  focusRequest = 0,
  onRemoveIntent,
  onSend,
}: ComposerProps) {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedModelOption =
    models.find((model) => model.id === selectedModel) ?? models.find((model) => model.available);
  const reasoningOptions = selectedModelOption?.reasoningLevels ?? [];
  const effectiveReasoning = reasoningOptions.includes(selectedReasoning)
    ? selectedReasoning
    : reasoningOptions[0];
  const modelMenuDisabled = disabled || busy || modelLocked;
  const taskNeedsData = Boolean(intent) && !hasAvailableData && files.length === 0;

  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    if (modelMenuDisabled) setModelMenuOpen(false);
  }, [modelMenuDisabled]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnKeyDown);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnKeyDown);
    };
  }, [modelMenuOpen]);

  const submit = () => {
    if (disabled || busy) return;
    if (taskNeedsData) {
      setError('请先添加 XLSX、XLSM 或 CSV 数据文件，再启动专业分析。');
      return;
    }
    if (!content.trim() && !intent) {
      setError(
        files.length > 0
          ? '请补充分析目标；也可以先选择一项分析任务。'
          : '请输入消息，或先选择一项分析任务。',
      );
      return;
    }
    const validation = validateFiles(files);
    if (validation) {
      setError(validation);
      return;
    }
    const supplement = content.trim();
    const outgoingContent = intent
      ? [intent.prompt, supplement ? `补充要求：${supplement}` : ''].filter(Boolean).join('\n\n')
      : supplement;
    onSend(outgoingContent, files, Boolean(intent));
    setContent('');
    setFiles([]);
    setError(null);
    onRemoveIntent?.();
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="composer-wrap">
      <form
        className={`composer${files.length > 0 ? ' composer-with-files' : ''}`}
        data-disabled={disabled || busy}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="composer-meta">
          <span className="mode-label">
            {intent ? `分析任务 · ${intent.title}` : '建筑能源分析'}
          </span>
          {intent && (
            <button
              type="button"
              className="icon-button composer-intent-remove"
              aria-label={`移除${intent.title}意图`}
              title="移除分析意图"
              onClick={onRemoveIntent}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
          <span className="keyboard-hint">
            {disabled
              ? (disabledMessage ?? '当前任务正在执行，请等待完成后再发送')
              : busy
                ? '正在处理请求…'
                : taskNeedsData
                  ? '请先添加数据文件'
                : 'Enter 发送 · Shift+Enter 换行'}
          </span>
        </div>
        <label className="composer-input">
          <span className="sr-only">输入建筑能源分析需求</span>
          <textarea
            ref={textareaRef}
            rows={1}
            value={content}
            disabled={disabled || busy}
            placeholder={
              disabled
                ? (disabledMessage ?? '当前任务正在执行，请等待完成后再发送')
                : busy
                  ? '正在处理请求…'
                  : intent
                    ? taskNeedsData
                      ? '请先添加数据文件，可选填补充要求…'
                      : '可补充时间范围、目标点位或输出要求…'
                    : '描述分析需求，或添加数据文件…'
            }
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {files.length > 0 && (
          <div className="pending-files" role="list" aria-label="待上传文件">
            {files.map((file, index) => (
              <span className="pending-file" key={`${file.name}-${file.size}-${index}`}>
                <FileSpreadsheet size={16} aria-hidden="true" />
                <span>
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)}</small>
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  onClick={() =>
                    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <div className="attachment-action">
            <label className="icon-text-button" title="添加 XLSX、XLSM 或 CSV">
              <Paperclip size={18} aria-hidden="true" />
              <span className="sr-only">添加文件</span>
              <input
                ref={inputRef}
                type="file"
                aria-label="上传数据文件"
                accept=".xlsx,.xlsm,.csv"
                multiple
                disabled={disabled || busy}
                onChange={(event) => {
                  const next = [...files, ...Array.from(event.target.files ?? [])];
                  const validation = validateFiles(next);
                  setError(validation);
                  if (!validation) setFiles(next);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              />
            </label>
          </div>
          {selectedModelOption && (
            <div className="model-picker" ref={modelMenuRef}>
              <button
                type="button"
                className="model-menu-trigger"
                aria-label={`模型设置：${selectedModelOption.displayName} · ${reasoningLabels[effectiveReasoning ?? 'xhigh']}${modelLocked ? '（已固定）' : ''}`}
                aria-haspopup="menu"
                aria-expanded={modelMenuOpen}
                disabled={modelMenuDisabled}
                onClick={() => setModelMenuOpen((open) => !open)}
              >
                <span>
                  <strong>{selectedModelOption.displayName}</strong>
                  <span aria-hidden="true">
                    {' '}
                    · {reasoningLabels[effectiveReasoning ?? 'xhigh']}
                  </span>
                </span>
                {modelLocked ? (
                  <LockKeyhole size={13} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} aria-hidden="true" />
                )}
              </button>
              {modelMenuOpen && (
                <div className="model-menu" role="menu" aria-label="模型与推理设置">
                  <div className="model-menu-group">
                    <span className="model-menu-label">模型</span>
                    {models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className="model-menu-option"
                        role="menuitemradio"
                        aria-checked={model.id === selectedModelOption.id}
                        disabled={disabled || busy || modelLocked || !model.available}
                        onClick={() => {
                          const nextReasoning = model.reasoningLevels.includes(selectedReasoning)
                            ? selectedReasoning
                            : model.reasoningLevels[0];
                          if (nextReasoning) onModelChange?.(model.id, nextReasoning);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span>{model.displayName}</span>
                        {model.id === selectedModelOption.id && (
                          <Check size={14} aria-hidden="true" />
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="model-menu-group">
                    <span className="model-menu-label">推理强度</span>
                    {reasoningOptions.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className="model-menu-option"
                        role="menuitemradio"
                        aria-checked={level === effectiveReasoning}
                        disabled={disabled || busy || modelLocked || !selectedModelOption.available}
                        onClick={() => {
                          onModelChange?.(selectedModelOption.id, level);
                          setModelMenuOpen(false);
                        }}
                      >
                        <span>{reasoningLabels[level]}</span>
                        {level === effectiveReasoning && <Check size={14} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            type="submit"
            className="send-button send-action"
            aria-label="发送消息"
            disabled={disabled || busy}
          >
            <Send size={18} aria-hidden="true" />
          </button>
        </div>
        {error && (
          <p className="composer-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
