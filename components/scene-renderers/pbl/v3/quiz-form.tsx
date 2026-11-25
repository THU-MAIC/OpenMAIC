'use client';
import { useId } from 'react';
import { Check, ClipboardCheck, LoaderCircle, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import { cn } from '@/lib/utils';

/**
 * The stage's quiz: its questions, what the last submission got right, and the way to submit.
 * The same form in the task drawer and in the card by the avatar, on the same answers.
 */
export function QuizForm({
  questions,
  answers,
  quiz,
  canSubmit,
  disabled,
  unchanged,
  submitting,
  onAnswer,
  onSubmit,
}: {
  questions: LearningView['questions'];
  answers: readonly (number | null | undefined)[];
  /** The last submission, once there is one. */
  quiz?: { passed: boolean; score: number; total: number } | null;
  canSubmit: boolean;
  disabled: boolean;
  /** The answers are the ones already submitted. */
  unchanged: boolean;
  submitting: boolean;
  onAnswer: (question: number, option: number) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  return (
    <>
      {questions.map((question, index) => (
        <fieldset
          key={index}
          className="min-w-0 rounded-xl border border-border bg-background/70 p-3"
        >
          <legend className="sr-only">{question.q}</legend>
          <div className="mb-3 flex items-start gap-2.5" aria-hidden="true">
            <span className="inline-flex h-7 min-w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 px-1.5 text-xs font-semibold tabular-nums text-primary">
              {String(index + 1).padStart(2, '0')}
            </span>
            <p className="min-w-0 break-words pt-0.5 font-semibold leading-6">{question.q}</p>
          </div>
          <div className="grid gap-2">
            {question.options.map((option, i) => {
              const selected = answers[index] === i;
              const result =
                question.feedback?.selectedAnswer === i ? question.feedback : undefined;
              return (
                <label className="relative block" data-selected={selected} key={i}>
                  <input
                    type="radio"
                    className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
                    name={`${formId}-quiz-${index}`}
                    disabled={submitting}
                    checked={selected}
                    onChange={() => onAnswer(index, i)}
                  />
                  <span
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-card-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:opacity-65',
                      result
                        ? result.passed
                          ? 'border-emerald-500/70 bg-emerald-500/10'
                          : 'border-red-500/70 bg-red-500/10'
                        : selected
                          ? 'border-foreground/60 bg-muted'
                          : 'border-border bg-card peer-hover:bg-accent/40',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
                    >
                      {i < 26 ? String.fromCharCode(65 + i) : i + 1}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 leading-5">
                      {option}
                    </span>
                    {result &&
                      (result.passed ? (
                        <Check
                          aria-hidden="true"
                          size={18}
                          className="mt-1 shrink-0 text-emerald-700 dark:text-emerald-300"
                        />
                      ) : (
                        <X
                          aria-hidden="true"
                          size={18}
                          className="mt-1 shrink-0 text-red-700 dark:text-red-300"
                        />
                      ))}
                    {result && (
                      <span className="sr-only">
                        {t(result.passed ? 'pblV3.quizCorrect' : 'pblV3.quizIncorrect')}
                      </span>
                    )}
                    <span
                      aria-hidden="true"
                      className="mt-1.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-current text-muted-foreground"
                    >
                      {selected && <span className="size-2 rounded-full bg-current" />}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {question.feedback && (
            <div
              data-testid="pbl-quiz-feedback"
              role="status"
              className={cn(
                'mt-3 rounded-lg border p-3 text-sm',
                question.feedback.passed
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-red-500/30 bg-red-500/10',
              )}
            >
              <p className="font-semibold">
                {t(question.feedback.passed ? 'pblV3.quizCorrect' : 'pblV3.quizIncorrect')}
              </p>
              <p>{question.feedback.explanation ?? t('pblV3.quizReviewHint')}</p>
              {question.feedback.selectedAnswer !== undefined &&
                answers[index] !== question.feedback.selectedAnswer && (
                  <p className="mt-1 text-muted-foreground">{t('pblV3.quizChanged')}</p>
                )}
            </div>
          )}
        </fieldset>
      ))}
      {questions.length > 0 && quiz && (
        <p
          role="status"
          className="rounded-lg border border-border bg-muted/45 px-3 py-2 text-xs font-medium text-foreground"
        >
          {t(quiz.passed ? 'pblV3.quizPassed' : 'pblV3.quizRetry', {
            score: quiz.score,
            total: quiz.total,
          })}
        </p>
      )}
      {canSubmit && (
        <button
          type="button"
          className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-transparent bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none disabled:cursor-default disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none motion-reduce:transition-none sm:w-auto sm:justify-self-end"
          disabled={
            disabled ||
            unchanged ||
            questions.some(
              (question, index) =>
                !Number.isInteger(answers[index]) ||
                answers[index]! < 0 ||
                answers[index]! >= question.options.length,
            )
          }
          aria-busy={submitting}
          onClick={onSubmit}
        >
          {submitting ? (
            <LoaderCircle aria-hidden="true" size={16} className="animate-spin" />
          ) : unchanged ? (
            <Check aria-hidden="true" size={16} />
          ) : (
            <ClipboardCheck aria-hidden="true" size={16} />
          )}
          {t(
            submitting
              ? 'pblV3.submitting'
              : unchanged
                ? 'pblV3.submitted'
                : quiz
                  ? 'pblV3.resubmit'
                  : 'pblV3.submitQuiz',
          )}
        </button>
      )}
    </>
  );
}
