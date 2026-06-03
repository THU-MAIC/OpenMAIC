'use client';

import { Reorder, useDragControls } from 'motion/react';
import { ChevronRight, GripVertical, Plus, Trash2, ChevronUp, ChevronDown, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { QuizQuestion, QuizQuestionType } from '@/lib/types/stage';
import { MAX_OPTIONS, isChoice, optionLetter } from './quiz-edit-ops';
import {
  addQuizOption,
  deleteQuizOption,
  deleteQuizQuestion,
  patchQuizQuestion,
  reorderQuizOptions,
  setQuizQuestionType,
  toggleQuizCorrect,
  typeQuizOptionLabel,
  typeQuizQuestion,
} from './use-quiz-surface';

const TYPES: QuizQuestionType[] = ['single', 'multiple', 'short_answer'];

/** Stop a pointer event from reaching the Reorder.Item drag listener. */
const stopDrag = (e: React.PointerEvent) => e.stopPropagation();

interface Props {
  readonly question: QuizQuestion;
  readonly index: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

export function QuestionCard({ question: q, index, expanded, onToggle }: Props) {
  const { t } = useI18n();
  const controls = useDragControls();
  const choice = isChoice(q.type);

  return (
    <Reorder.Item
      value={q.id}
      data-testid="quiz-question"
      data-question-type={q.type}
      dragListener={false}
      dragControls={controls}
      layout="position"
      whileDrag={{ scale: 1.01, zIndex: 30 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
    >
      {/* Header row — caret + summary toggles expansion; grip drags; trash deletes. */}
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button
          type="button"
          aria-label={t('edit.quiz.reorder')}
          onPointerDown={(e) => controls.start(e)}
          className="cursor-grab touch-none text-zinc-300 hover:text-zinc-500 active:cursor-grabbing dark:text-zinc-600 dark:hover:text-zinc-400"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <button
          type="button"
          onPointerDown={stopDrag}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 shrink-0 text-zinc-400 transition-transform',
              expanded && 'rotate-90',
            )}
          />
          <span className="shrink-0 text-xs font-semibold text-zinc-400">{index + 1}</span>
          <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {t(`edit.quiz.type.${q.type}`)}
          </span>
          <span className="truncate text-sm text-zinc-700 dark:text-zinc-200">
            {q.question || t('edit.quiz.untitledQuestion')}
          </span>
        </button>
        <button
          type="button"
          aria-label={t('edit.quiz.deleteQuestion')}
          onPointerDown={stopDrag}
          onClick={() => deleteQuizQuestion(q.id)}
          className="shrink-0 rounded-md p-1 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <div className="flex flex-col gap-4 border-t border-zinc-100 px-3.5 pb-4 pt-3 dark:border-zinc-800">
          {/* Question text */}
          <Field label={t('edit.quiz.questionLabel')}>
            <Textarea
              value={q.question}
              onPointerDown={stopDrag}
              onChange={(e) =>
                typeQuizQuestion(q.id, { question: e.target.value }, `${q.id}:question`)
              }
              placeholder={t('edit.quiz.questionPlaceholder')}
              rows={2}
            />
          </Field>

          {/* Type + points row */}
          <div className="flex gap-3">
            <Field label={t('edit.quiz.typeLabel')} className="flex-1">
              <Select
                value={q.type}
                onValueChange={(v) => setQuizQuestionType(q.id, v as QuizQuestionType)}
              >
                <SelectTrigger onPointerDown={stopDrag}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`edit.quiz.type.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('edit.quiz.pointsLabel')} className="w-24">
              <Input
                type="number"
                min={0}
                value={q.points ?? 1}
                onPointerDown={stopDrag}
                onChange={(e) => {
                  const n = e.target.value === '' ? 0 : Number(e.target.value);
                  if (Number.isNaN(n)) return;
                  typeQuizQuestion(q.id, { points: n }, `${q.id}:points`);
                }}
              />
            </Field>
          </div>

          {/* Options (choice questions only) */}
          {choice && (
            <Field label={t('edit.quiz.optionsLabel')}>
              <div className="flex flex-col gap-1.5">
                {(q.options ?? []).map((opt, i) => {
                  const correct = q.answer?.includes(opt.value) ?? false;
                  // `opt.value` is the positional letter (A/B/C…), so this key
                  // is positional, not identity-stable. That's intentional:
                  // QuizOption has no id, and reorder is driven by the up/down
                  // buttons (focus stays on the button), so React reconciling
                  // the label inputs by position is invisible in practice.
                  return (
                    <div key={opt.value} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        aria-label={t('edit.quiz.markCorrect')}
                        aria-pressed={correct}
                        onPointerDown={stopDrag}
                        onClick={() => toggleQuizCorrect(q.id, i)}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center border text-[11px] font-bold transition-colors',
                          q.type === 'single' ? 'rounded-full' : 'rounded-md',
                          correct
                            ? 'border-emerald-500 bg-emerald-500 text-white'
                            : 'border-zinc-300 text-zinc-400 hover:border-emerald-400 dark:border-zinc-600',
                        )}
                      >
                        {optionLetter(i)}
                      </button>
                      <Input
                        value={opt.label}
                        onPointerDown={stopDrag}
                        onChange={(e) => typeQuizOptionLabel(q.id, i, e.target.value)}
                        placeholder={t('edit.quiz.optionPlaceholder')}
                        className="flex-1"
                      />
                      <div className="flex shrink-0 items-center">
                        <IconButton
                          label={t('edit.quiz.moveUp')}
                          disabled={i === 0}
                          onClick={() => reorderQuizOptions(q.id, i, i - 1)}
                        >
                          <ChevronUp className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          label={t('edit.quiz.moveDown')}
                          disabled={i === (q.options?.length ?? 0) - 1}
                          onClick={() => reorderQuizOptions(q.id, i, i + 1)}
                        >
                          <ChevronDown className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          label={t('edit.quiz.deleteOption')}
                          disabled={(q.options?.length ?? 0) <= 1}
                          onClick={() => deleteQuizOption(q.id, i)}
                        >
                          <X className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={(q.options?.length ?? 0) >= MAX_OPTIONS}
                  onPointerDown={stopDrag}
                  onClick={() => addQuizOption(q.id)}
                  className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-50 disabled:pointer-events-none disabled:opacity-40 dark:text-violet-300 dark:hover:bg-violet-500/10"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('edit.quiz.addOption')}
                </button>
              </div>
            </Field>
          )}

          {/* Short-answer grading fields */}
          {!choice && (
            <>
              <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
                <Switch
                  checked={q.hasAnswer ?? false}
                  onCheckedChange={(v) => patchQuizQuestion(q.id, { hasAnswer: v })}
                />
                {t('edit.quiz.hasAnswerLabel')}
              </label>
              <Field label={t('edit.quiz.commentPromptLabel')}>
                <Textarea
                  value={q.commentPrompt ?? ''}
                  onPointerDown={stopDrag}
                  onChange={(e) =>
                    typeQuizQuestion(
                      q.id,
                      { commentPrompt: e.target.value },
                      `${q.id}:commentPrompt`,
                    )
                  }
                  placeholder={t('edit.quiz.commentPromptPlaceholder')}
                  rows={2}
                />
              </Field>
            </>
          )}

          {/* Analysis (all types) */}
          <Field label={t('edit.quiz.analysisLabel')}>
            <Textarea
              value={q.analysis ?? ''}
              onPointerDown={stopDrag}
              onChange={(e) =>
                typeQuizQuestion(q.id, { analysis: e.target.value }, `${q.id}:analysis`)
              }
              placeholder={t('edit.quiz.analysisPlaceholder')}
              rows={2}
            />
          </Field>
        </div>
      )}
    </Reorder.Item>
  );
}

function Field({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={stopDrag}
      onClick={onClick}
      className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
    >
      {children}
    </button>
  );
}
