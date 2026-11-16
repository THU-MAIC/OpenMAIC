'use client';

import type { LearningView } from '@/lib/pbl/v3/types';
import {
  DECISION_RESPONSE_MAX_LENGTH,
  isDecisionResponseValid,
  isDecisionResponseWithinLimits,
  isDecisionResponseStorable,
  type DecisionRecord,
} from '@/lib/pbl/v3/domain/orchestration/decisions';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Check, LoaderCircle } from 'lucide-react';

export interface DecisionDraft {
  chosen: string;
  rationale: string;
}

export function DecisionResponseForm({
  decision,
  selected,
  draft,
  disabled,
  pendingChosen,
  onDraftChange,
  onSubmit,
}: {
  decision: LearningView['decisions'][number];
  selected?: DecisionRecord;
  draft?: DecisionDraft;
  disabled: boolean;
  pendingChosen?: string;
  onDraftChange: (draft: DecisionDraft) => void;
  onSubmit: (chosen: string, rationale?: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const textResponse = decision.responseType === 'text';
  const hasForm = textResponse || decision.requiresRationale;
  const value = draft ?? { chosen: selected?.chosen ?? '', rationale: selected?.rationale ?? '' };
  const valid = isDecisionResponseValid(decision, value);
  const unchanged =
    selected?.chosen === value.chosen && (selected.rationale ?? '') === value.rationale;
  return (
    <fieldset disabled={disabled} className="grid gap-3" data-testid="pbl-decision-response">
      <legend className="whitespace-pre-wrap text-sm font-medium">{decision.prompt}</legend>
      {textResponse ? (
        <label className="grid gap-1 text-sm">
          {t('pblV3.decisionResponse')}
          <textarea
            className="min-h-28 w-full rounded-md border bg-background p-3 text-sm"
            rows={4}
            maxLength={DECISION_RESPONSE_MAX_LENGTH}
            required
            value={value.chosen}
            onChange={(event) => onDraftChange({ ...value, chosen: event.target.value })}
          />
        </label>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {decision.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="rounded-md border px-2 py-1 text-xs disabled:opacity-40 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary"
              disabled={disabled || (!hasForm && selected?.chosen === option.id)}
              aria-busy={pendingChosen === option.id}
              aria-pressed={
                hasForm
                  ? value.chosen === option.id
                  : (pendingChosen ?? selected?.chosen) === option.id
              }
              onClick={() =>
                hasForm ? onDraftChange({ ...value, chosen: option.id }) : void onSubmit(option.id)
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {decision.requiresRationale && (
        <label className="grid gap-1 text-sm">
          {t('pblV3.decisionRationale')}
          <textarea
            className="min-h-20 w-full rounded-md border bg-background p-3 text-sm"
            rows={3}
            maxLength={DECISION_RESPONSE_MAX_LENGTH}
            required
            value={value.rationale}
            onChange={(event) => onDraftChange({ ...value, rationale: event.target.value })}
          />
        </label>
      )}
      {hasForm && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-transparent bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-default disabled:border-border disabled:bg-muted disabled:text-muted-foreground"
            disabled={disabled || !valid || unchanged}
            aria-busy={pendingChosen !== undefined}
            onClick={() => void onSubmit(value.chosen, value.rationale || undefined)}
          >
            {pendingChosen !== undefined ? (
              <LoaderCircle size={16} aria-hidden="true" className="animate-spin" />
            ) : unchanged ? (
              <Check size={16} aria-hidden="true" />
            ) : null}
            {t(
              pendingChosen !== undefined
                ? 'pblV3.submitting'
                : unchanged
                  ? 'pblV3.submitted'
                  : selected
                    ? 'pblV3.resubmit'
                    : 'pblV3.submitDecision',
            )}
          </button>
          {selected && (
            <span className={unchanged ? 'sr-only' : 'text-xs text-muted-foreground'} role="status">
              {t(unchanged ? 'pblV3.decisionSaved' : 'pblV3.decisionUnsaved')}
            </span>
          )}
        </div>
      )}
      {!hasForm && selected && (
        <span role="status" className="text-xs text-muted-foreground">
          {t('pblV3.submitted')}
        </span>
      )}
      {!isDecisionResponseWithinLimits(value) && (
        <p role="alert" className="text-xs text-destructive">
          {t('pblV3.decisionTooLong', { max: DECISION_RESPONSE_MAX_LENGTH })}
        </p>
      )}
      {!isDecisionResponseStorable(value) && (
        <p role="alert" className="text-xs text-destructive">
          {t('pblV3.decisionInvalidText')}
        </p>
      )}
    </fieldset>
  );
}
