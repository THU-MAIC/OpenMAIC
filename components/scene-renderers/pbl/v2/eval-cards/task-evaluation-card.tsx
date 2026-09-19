/**
 * PBL v2 — Task evaluation card.
 *
 * Rendered inside an assistant chat bubble (NOT a standalone full-
 * width card — task eval is "small judgement step" per PR 6 D1-B).
 * Appears after the learner submits something AND advance_micro_task
 * fires the task eval flow.
 *
 * Fields used: strengths[], improvements[], score? — none of
 * what_you_built / what_you_learned / stars (those belong to other
 * evaluation kinds). Score is OPTIONAL: if the LLM omitted it we
 * just render the prose lists; no fake "/100" appears.
 *
 * Visual scope:
 *  - tight, fits inside a chat bubble (max-width ~80%)
 *  - strengths on top (green-ish accent), improvements below
 *    (amber accent for "可以更好" — keep it light, not negative)
 *  - score chip, top-right, hidden when score is undefined
 *
 * Design choice: we do NOT show stars on task eval. Stars are for
 * milestone + final reflection moments. Mixing star icons here
 * would dilute the visual contract.
 */

'use client';

import { ClipboardCheck, TrendingUp, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { PBLEvaluation } from '@/lib/pbl/v2/types';

interface Props {
  evaluation: PBLEvaluation;
  className?: string;
}

export function TaskEvaluationCard({ evaluation, className }: Props) {
  const { t } = useI18n();
  if (evaluation.kind !== 'task') return null;
  const strengths = evaluation.strengths ?? [];
  const improvements = evaluation.improvements ?? [];
  const score = typeof evaluation.score === 'number' ? evaluation.score : undefined;
  if (strengths.length === 0 && improvements.length === 0 && score === undefined) {
    return null;
  }

  return (
    <div
      className={cn(
        'pbl-v2-task-review-card mt-2 space-y-3 rounded-2xl px-3.5 py-3 text-sm text-slate-800',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-violet-700">
          <ClipboardCheck className="h-3 w-3" />
          {t('pbl.v2.taskEvalCard.title')}
        </span>
        {score !== undefined && (
          <span
            className="rounded-md border border-violet-200/70 bg-violet-100/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-violet-700 shadow-sm"
            aria-label={`Score ${score} out of 100`}
          >
            {score} / 100
          </span>
        )}
      </div>

      {strengths.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-indigo-700 mb-1.5 font-medium">
            <Sparkles className="w-3 h-3" />
            {t('pbl.v2.taskEvalCard.strengths')}
          </div>
          <ul className="space-y-1 text-sm leading-snug text-slate-700">
            {strengths.map((s, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="shrink-0 text-indigo-600">✓</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {improvements.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-cyan-700 mb-1.5 font-medium">
            <TrendingUp className="w-3 h-3" />
            {t('pbl.v2.taskEvalCard.improvements')}
          </div>
          <ul className="space-y-1 text-sm leading-snug text-slate-700">
            {improvements.map((s, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="shrink-0 text-cyan-700">→</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
