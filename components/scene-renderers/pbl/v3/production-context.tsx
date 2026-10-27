'use client';
import { ClipboardCheck, FileCode2, ListChecks } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LearningView } from '@/lib/pbl/v3/types';
import { useI18n } from '@/lib/hooks/use-i18n';

/** OpenPBL's production drawer: submitted decisions, plan, output and review status. */
export function ProductionContext({ view }: { view: LearningView }) {
  const { t } = useI18n();
  if (view.stage.kind !== 'produce') return null;
  const collected = view.state.collected[view.state.position.milestoneId ?? ''];
  const planning = view.stage.writes === 'plan';
  const artifact = collected?.[view.stage.writes];
  const reviewed = planning ? collected?.planReviewCompleted : collected?.codeReviewCompleted;
  const section = (icon: ReactNode, title: string, children: ReactNode) => (
    <section className="grid gap-2 rounded-lg bg-muted/50 p-3 text-sm leading-[1.5]">
      <header className="flex items-center gap-1.5 font-semibold">
        {icon}
        <h5>{title}</h5>
      </header>
      {children}
    </section>
  );
  return (
    <div className="grid gap-3">
      {section(
        <ClipboardCheck size={15} />,
        t('pblV3.journey.confirmedDecisions'),
        view.decisionSummary?.length ? (
          <ol className="grid list-decimal gap-2 pl-5">
            {view.decisionSummary.map((decision) => (
              <li key={decision.id}>
                <strong className="block font-semibold">{decision.prompt}</strong>
                <span className="whitespace-pre-wrap text-muted-foreground">{decision.choice}</span>
                {decision.rationale && (
                  <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                    {t('pblV3.decisionRationale')}: {decision.rationale}
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">{t('pblV3.journey.noDecisions')}</p>
        ),
      )}
      {!planning &&
        section(
          <ListChecks size={15} />,
          t('pblV3.journey.approvedPlan'),
          <p className="text-xs text-muted-foreground">{t('pblV3.journey.planArtifact')}</p>,
        )}
      {section(
        <FileCode2 size={15} />,
        t(planning ? 'pblV3.journey.planOutput' : 'pblV3.journey.codeOutput'),
        <>
          {artifact && (
            <span className="text-xs font-semibold text-primary">
              {t('pblV3.journey.savedVersion', { version: artifact.revision + 1 })}
            </span>
          )}
          <p className="text-xs text-muted-foreground">
            {t(planning ? 'pblV3.journey.planArtifact' : 'pblV3.journey.codeArtifact')}
          </p>
          {view.stage.reviewRequired && (
            <span
              className={`rounded-md px-2 py-1.5 text-xs ${reviewed ? 'bg-accent text-primary' : 'bg-background text-muted-foreground'}`}
            >
              {t(planning ? 'pblV3.journey.planReview' : 'pblV3.journey.codeReview')}
              {' · '}
              {t(reviewed ? 'pblV3.journey.reviewApproved' : 'pblV3.journey.reviewPending')}
            </span>
          )}
        </>,
      )}
    </div>
  );
}
