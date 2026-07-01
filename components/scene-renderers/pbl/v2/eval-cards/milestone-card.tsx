/**
 * PBL v2 — Milestone reflection + handover (combined) card.
 *
 * Per PR 6 D7-B: we merge what the refactor/openmaic-pbl repo had as
 * TWO separate cards (MilestoneNarrativeCard + HandoverCard) into ONE
 * card so the learner doesn't have to scroll past evaluation prose
 * to reach the "继续到下一阶段" button.
 *
 * Card sections (top → bottom):
 *   1. Header strip: 阶段完成 ribbon + StarRating (plain, no /5)
 *   2. Narrative paragraph (the LLM's prose, with the JSON tail
 *      stripped via stripEvaluationTail)
 *   3. "你学到了" bullets (from evaluation.strengths a.k.a. `learned`)
 *   4. "这阶段你..." prose line (from evaluation.improvements[0]
 *      a.k.a. `performance`)
 *   5. Handover footer: next-milestone label + "继续到下一阶段" CTA.
 *      The button is the ONLY way to cross into the next stage —
 *      while `pendingHandover.consumed === false` the next milestone
 *      stays LOCKED in the store (gate enforced by continueAfter
 *      Handover in operations/progress.ts).
 *
 * Visual scope:
 *  - full-width (not a bubble); breaks out of the chat's max-width
 *    cell so the card feels like a "moment", not a message.
 *  - gentle gradient background to distinguish from regular bubbles.
 *
 * Final-milestone case: when there is no `pendingHandover` (we just
 * completed the LAST milestone of the project) the footer renders a
 * "项目即将完成" label instead of the Continue button. The
 * CompletionCtaCard renders separately AFTER the final evaluation
 * finishes streaming.
 */

'use client';

import { ArrowRight, CheckCircle2, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  sanitizeMilestoneEvaluationFeedback,
  stripEvaluationTail,
} from '@/lib/pbl/v2/operations/eval-tail-parser';
import { MarkdownText } from '../markdown-text';
import { StarRating } from './star-rating';
import type { PBLEvaluation, PBLHandover } from '@/lib/pbl/v2/types';

interface Props {
  evaluation: PBLEvaluation;
  /** When present, render the Continue CTA. When absent (final
   *  milestone), render the project-completion label instead. */
  handover?: PBLHandover;
  /** Called when the learner clicks "继续到下一阶段". The wiring
   *  (continueAfterHandover + open-task setup) lives in PR 6.6. */
  onContinue?: () => void;
  className?: string;
}

export function MilestoneCard({ evaluation, handover, onContinue, className }: Props) {
  const { t } = useI18n();
  if (evaluation.kind !== 'milestone') return null;
  const learned = evaluation.strengths ?? [];
  const performance = (evaluation.improvements ?? [])[0] ?? '';
  const stars = typeof evaluation.stars === 'number' ? evaluation.stars : null;
  const rawNarrative = stripEvaluationTail(
    sanitizeMilestoneEvaluationFeedback(evaluation.feedback ?? ''),
  );
  const narrative = handover ? rawNarrative : stripFinalMilestoneContinueGuidance(rawNarrative);
  const ctaState = milestoneHandoverCtaState(handover);
  const consumed = ctaState === 'consumed';

  return (
    <div
      className={cn(
        'relative space-y-4 overflow-hidden rounded-2xl border border-violet-200/85 bg-[linear-gradient(145deg,rgba(252,250,255,0.98)_0%,rgba(238,242,255,0.94)_48%,rgba(232,250,255,0.96)_100%)] p-5 text-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_22px_58px_rgba(8,18,38,0.30),0_0_0_1px_rgba(139,92,246,0.10),0_0_42px_rgba(34,211,238,0.10)] ring-1 ring-violet-300/20',
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-violet-500 via-indigo-500 to-cyan-400" />
      <div className="pointer-events-none absolute -right-16 -top-20 h-44 w-44 rounded-full bg-cyan-200/35 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-16 h-48 w-48 rounded-full bg-violet-200/30 blur-3xl" />
      {/* Header */}
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-violet-700">
          <span className="flex h-7 w-7 items-center justify-center rounded-full border border-violet-200 bg-violet-100 text-violet-700">
            <Flag className="w-4 h-4" />
          </span>
          {t('pbl.v2.milestoneCard.title')}
        </div>
        {stars !== null && (
          <div className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1">
            <StarRating value={stars} size={18} />
          </div>
        )}
      </div>

      {/* Narrative paragraph */}
      {narrative && (
        <div className="relative text-sm leading-relaxed text-slate-800">
          <MarkdownText
            content={narrative}
            className="pbl-v2-light-card-markdown text-slate-700 prose-p:text-slate-700 prose-strong:text-slate-900 prose-li:marker:text-violet-500"
          />
        </div>
      )}

      {/* Learned bullets */}
      {learned.length > 0 && (
        <div className="relative">
          <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium mb-2">
            {t('pbl.v2.milestoneCard.youLearned')}
          </div>
          <ul className="space-y-1.5 text-[13px] text-slate-700">
            {learned.map((s, i) => (
              <li key={i} className="flex gap-2">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Performance prose */}
      {performance && (
        <div className="relative border-l-2 border-violet-300 bg-white/35 py-1.5 pl-3 pr-2 text-[13px] italic text-slate-600">
          {performance}
        </div>
      )}

      {/* Handover footer */}
      <div className="relative border-t border-violet-200/80 pt-2">
        {handover ? (
          <div className="space-y-2">
            <div className="text-xs text-slate-600">
              {t('pbl.v2.milestoneCard.nextStage')}
              <span className="font-medium text-slate-800 ml-1">{handover.nextMilestoneTitle}</span>
              {!consumed && (
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {t('pbl.v2.milestoneCard.continueHint')}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={consumed ? undefined : onContinue}
              disabled={consumed}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition-all',
                consumed
                  ? 'cursor-default border border-slate-300 bg-slate-100 text-slate-500 shadow-none'
                  : 'bg-gradient-to-r from-violet-600 to-cyan-500 text-white shadow-[0_12px_28px_rgba(99,102,241,0.30),0_0_22px_rgba(34,211,238,0.18)] hover:from-violet-500 hover:to-cyan-400 hover:shadow-[0_16px_34px_rgba(99,102,241,0.38),0_0_28px_rgba(34,211,238,0.24)]',
              )}
            >
              {consumed ? (
                <>
                  <CheckCircle2 className="w-4 h-4" />
                  {t('pbl.v2.milestoneCard.alreadyEntered')}
                </>
              ) : (
                <>
                  {t('pbl.v2.milestoneCard.continueToNext')}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            {t('pbl.v2.milestoneCard.projectAlmostDone')}
          </div>
        )}
      </div>
    </div>
  );
}

export function milestoneHandoverCtaState(handover?: PBLHandover): 'hidden' | 'ready' | 'consumed' {
  if (!handover) return 'hidden';
  return handover.consumed ? 'consumed' : 'ready';
}

export function stripFinalMilestoneContinueGuidance(text: string): string {
  return text
    .replace(
      /(?:[。！？!?]\s*)?[^。！？!?]*(?:点击|按|选择)\s*(?:右侧|下方|这个)?\s*(?:Continue|继续)(?:\s*按钮)?[^。！？!?]*(?:[。！？!?]|$)/giu,
      (match) => {
        const trimmed = match.trimStart();
        return trimmed.startsWith('。') || trimmed.startsWith('！') || trimmed.startsWith('？')
          ? trimmed.charAt(0)
          : '';
      },
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}
