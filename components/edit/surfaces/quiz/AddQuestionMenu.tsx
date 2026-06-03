'use client';

import { CircleDot, ListChecks, PencilLine, type LucideIcon } from 'lucide-react';
import { PopoverClose } from '@/components/ui/popover';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { QuizQuestionType } from '@/lib/types/stage';
import { addQuizQuestion } from './use-quiz-surface';

const TYPES: { type: QuizQuestionType; labelKey: string; Icon: LucideIcon }[] = [
  { type: 'single', labelKey: 'edit.quiz.type.single', Icon: CircleDot },
  { type: 'multiple', labelKey: 'edit.quiz.type.multiple', Icon: ListChecks },
  { type: 'short_answer', labelKey: 'edit.quiz.type.short_answer', Icon: PencilLine },
];

/**
 * Popover body for the "Add question" insert item — a small menu of the three
 * question types. Each entry appends a blank question of that type (one undo
 * step) and closes the popover via Radix's PopoverClose.
 */
export function AddQuestionMenu() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {t('edit.quiz.addQuestion')}
      </p>
      {TYPES.map(({ type, labelKey, Icon }) => (
        <PopoverClose asChild key={type}>
          <button
            type="button"
            onClick={() => addQuizQuestion(type)}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <Icon className="h-4 w-4 shrink-0 text-zinc-400" />
            <span>{t(labelKey)}</span>
          </button>
        </PopoverClose>
      ))}
    </div>
  );
}
