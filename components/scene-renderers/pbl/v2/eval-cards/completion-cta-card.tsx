/**
 * PBL v2 — Completion CTA card.
 *
 * Appears in chat ONCE the final evaluation has finished streaming.
 * It is NOT the completion report itself — the report is a separate
 * page (PR 7's completion.tsx). This card is the entry-point that
 * lets the learner re-read the chat history before opening the
 * report.
 *
 * Why a CTA in chat rather than auto-navigating: the user
 * explicitly asked for this in the refactor/openmaic-pbl repo —
 * forcibly navigating away robbed them of the chance to scroll
 * back through the milestone reflections. We respect that.
 *
 * Final milestone's MilestoneCard above renders without a Continue
 * button (handover is absent for the last milestone). Once the
 * final eval finishes, this card appears below it as the only
 * remaining action.
 */

'use client';

import { ArrowRight, PartyPopper } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';

interface Props {
  onView: () => void;
  className?: string;
}

export function CompletionCtaCard({ onView, className }: Props) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'space-y-3 rounded-2xl border border-cyan-100/[0.13] bg-gradient-to-br from-emerald-300/[0.16] via-primary/[0.16] to-purple-300/[0.14] p-5 shadow-[0_18px_46px_rgba(6,16,34,0.28)]',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-primary">
        <PartyPopper className="w-4 h-4" />
        {t('pbl.v2.completionCard.title')}
      </div>
      <div className="text-sm font-semibold leading-snug">
        {t('pbl.v2.completionCard.subtitle')}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t('pbl.v2.completionCard.description')}
      </p>
      <button
        type="button"
        onClick={onView}
        className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-[0_0_28px_rgba(155,124,255,0.26)] transition-opacity hover:opacity-90"
      >
        {t('pbl.v2.completion.completionCta')}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}
