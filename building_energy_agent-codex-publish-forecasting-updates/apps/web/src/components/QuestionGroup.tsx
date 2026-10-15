import { Check, ChevronLeft, ChevronRight, CircleHelp, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Question, QuestionSet } from '../domain';

interface QuestionGroupProps {
  questionSet: QuestionSet;
  busy: boolean;
  onSave(draft: Record<string, string>): Promise<void>;
  onSubmit(answers: Record<string, string>): void;
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: string;
  onChange(value: string): void;
}) {
  const freeTextSelected = value.startsWith('free:');
  return (
    <fieldset className="question-field">
      <legend>
        {question.question}
        {question.required && <span className="required-mark">必填</span>}
      </legend>
      {question.context && <p>{question.context}</p>}
      <div className="question-options">
        {question.options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={question.id}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{option}</span>
          </label>
        ))}
        {question.allowFreeText && (
          <label>
            <input
              type="radio"
              name={question.id}
              value="free"
              checked={freeTextSelected}
              onChange={() => onChange('free:')}
            />
            <span>自行输入</span>
          </label>
        )}
      </div>
      {question.allowFreeText && freeTextSelected && (
        <label className="free-answer">
          <span>你的回答</span>
          <input
            autoFocus
            value={value.slice(5)}
            onChange={(event) => onChange(`free:${event.target.value}`)}
          />
        </label>
      )}
    </fieldset>
  );
}

export function QuestionGroup({ questionSet, busy, onSave, onSubmit }: QuestionGroupProps) {
  const [answers, setAnswers] = useState<Record<string, string>>(questionSet.draft);
  const [currentIndex, setCurrentIndex] = useState(() => {
    const pendingIndex = questionSet.questions.findIndex((question) => {
      const value = questionSet.draft[question.id]?.trim() ?? '';
      return !value || value === 'free:';
    });
    return pendingIndex >= 0 ? pendingIndex : Math.max(0, questionSet.questions.length - 1);
  });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const firstRender = useRef(true);
  const questionSetId = useRef(questionSet.id);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (questionSetId.current === questionSet.id) return;
    questionSetId.current = questionSet.id;
    firstRender.current = true;
    setAnswers(questionSet.draft);
    const pendingIndex = questionSet.questions.findIndex((question) => {
      const value = questionSet.draft[question.id]?.trim() ?? '';
      return !value || value === 'free:';
    });
    setCurrentIndex(
      pendingIndex >= 0 ? pendingIndex : Math.max(0, questionSet.questions.length - 1),
    );
    setSavedAt(null);
    setSaveFailed(false);
  }, [questionSet.draft, questionSet.id, questionSet.questions]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSaveRef
        .current(answers)
        .then(() => {
          if (!cancelled) setSavedAt(new Date());
        })
        .catch(() => {
          if (!cancelled) setSaveFailed(true);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [answers]);

  const missing = useMemo(
    () =>
      questionSet.questions.filter((question) => {
        if (!question.required) return false;
        const value = answers[question.id]?.trim() ?? '';
        return !value || value === 'free:';
      }),
    [answers, questionSet.questions],
  );
  const currentQuestion = questionSet.questions[currentIndex];
  if (!currentQuestion) return null;
  const currentValue = answers[currentQuestion.id] ?? '';
  const currentMissing =
    currentQuestion.required && (!currentValue.trim() || currentValue.trim() === 'free:');
  const lastQuestion = currentIndex === questionSet.questions.length - 1;

  return (
    <section className="question-group" aria-labelledby={`question-title-${questionSet.id}`}>
      <header>
        <span className="question-icon" aria-hidden="true">
          <CircleHelp size={19} />
        </span>
        <div>
          <h2 id={`question-title-${questionSet.id}`}>需要确认</h2>
          <p>请逐项回答，完成后继续当前任务。</p>
        </div>
        <div className="question-header-actions">
          <span className="draft-state" aria-live="polite">
            <Save size={13} aria-hidden="true" />
            {saveFailed ? '草稿未保存' : savedAt ? '草稿已保存' : '草稿自动保存'}
          </span>
          <span className="question-position">
            第 {currentIndex + 1} / {questionSet.questions.length} 项
          </span>
          <span className="question-step-actions">
            {currentIndex > 0 && (
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => setCurrentIndex((index) => index - 1)}
              >
                <ChevronLeft size={15} aria-hidden="true" />
                上一项
              </button>
            )}
            {lastQuestion ? (
              <button
                type="button"
                className="primary-action"
                disabled={busy || missing.length > 0}
                onClick={() =>
                  onSubmit(
                    Object.fromEntries(
                      Object.entries(answers).map(([key, value]) => [
                        key,
                        value.startsWith('free:') ? value.slice(5).trim() : value,
                      ]),
                    ),
                  )
                }
              >
                <Check size={16} aria-hidden="true" />
                提交并继续
              </button>
            ) : (
              <button
                type="button"
                className="primary-action"
                disabled={busy || currentMissing}
                onClick={() => setCurrentIndex((index) => index + 1)}
              >
                下一项
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      </header>

      <div className="question-step" aria-live="polite">
        <QuestionField
          key={currentQuestion.id}
          question={currentQuestion}
          value={currentValue}
          onChange={(value) => {
            setSavedAt(null);
            setSaveFailed(false);
            setAnswers((current) => ({ ...current, [currentQuestion.id]: value }));
          }}
        />
      </div>
    </section>
  );
}
