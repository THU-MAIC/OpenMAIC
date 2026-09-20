'use client';

/**
 * Pre-outline ask_user clarification questions, rendered inline in the
 * generation pipeline card (below the step title). The step system owns the
 * title and description — this is only the question list and actions.
 *
 * The clarify preflight (POST /api/generate/clarify) returned structured
 * questions the model posed on its own. Submit resumes generation with the
 * answers; Skip resumes without them.
 */

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AskUserQuestion, ClarificationAnswer } from '@/lib/types/generation';

export function ClarificationPanel({
  questions,
  onSubmit,
  onSkip,
  onBack,
  isSubmitting = false,
}: {
  readonly questions: AskUserQuestion[];
  readonly onSubmit: (answers: Record<string, ClarificationAnswer>) => void;
  readonly onSkip: () => void;
  /** Back to the requirements form, mirroring the outline editor footer. */
  readonly onBack: () => void;
  readonly isSubmitting?: boolean;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  const toggleOption = (question: AskUserQuestion, optionId: string) => {
    setPicked((prev) => {
      const current = prev[question.id] ?? [];
      if (question.multiSelect) {
        return {
          ...prev,
          [question.id]: current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId],
        };
      }
      return { ...prev, [question.id]: current.includes(optionId) ? [] : [optionId] };
    });
  };

  const handleSubmit = () => {
    const answers: Record<string, ClarificationAnswer> = {};
    for (const question of questions) {
      const optionIds = picked[question.id] ?? [];
      const text = (freeText[question.id] ?? '').trim();
      if (optionIds.length === 0 && !text) continue;
      answers[question.id] = {
        ...(optionIds.length > 0 ? { optionIds } : {}),
        ...(text ? { freeText: text } : {}),
      };
    }
    onSubmit(answers);
  };

  return (
    <div className="w-full text-left" data-testid="clarification-panel">
      <div className="space-y-6">
        {questions.map((question, index) => {
          const selected = picked[question.id] ?? [];
          return (
            <fieldset key={question.id} className="space-y-3">
              <legend className="text-sm font-medium">
                {index + 1}. {question.question}
              </legend>
              {(question.options ?? []).length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label={question.question}>
                  {(question.options ?? []).map((option) => {
                    const isPicked = selected.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={isPicked}
                        data-testid={`clarification-option-${question.id}-${option.id}`}
                        onClick={() => toggleOption(question, option.id)}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-sm transition-colors',
                          isPicked
                            ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-300'
                            : 'border-muted bg-transparent text-foreground hover:border-blue-400',
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              )}
              {question.allowFreeText && (
                <Input
                  value={freeText[question.id] ?? ''}
                  onChange={(event) =>
                    setFreeText((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                  placeholder={t('generation.clarifyFreeTextPlaceholder')}
                  data-testid={`clarification-freetext-${question.id}`}
                  aria-label={question.question}
                />
              )}
            </fieldset>
          );
        })}
      </div>

      {/* Footer mirrors the outline editor: ghost back + ghost skip +
          primary confirm, all pill-shaped. */}
      <div className="mt-8 flex flex-col-reverse gap-2 md:flex-row md:items-center md:justify-end md:gap-2">
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={isSubmitting}
          data-testid="clarification-back"
          className="rounded-full px-4 text-muted-foreground hover:text-foreground"
        >
          {t('generation.backToRequirements')}
        </Button>
        <Button
          variant="ghost"
          onClick={onSkip}
          disabled={isSubmitting}
          data-testid="clarification-skip"
          className="rounded-full px-4 text-muted-foreground hover:text-foreground"
        >
          {t('generation.clarifySkip')}
        </Button>
        <Button
          onClick={handleSubmit}
          disabled={isSubmitting}
          data-testid="clarification-submit"
          className="rounded-full px-6 shadow-lg shadow-blue-500/20"
        >
          <Check className="size-4" />
          {t('generation.confirmAndGenerateOutline')}
        </Button>
      </div>
    </div>
  );
}
