'use client';

import { ChevronDown, Compass, Map, Monitor, Route } from 'lucide-react';
import { useId } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import type { LearningView } from '@/lib/pbl/v3/types';

export const PROJECT_OVERVIEW_ID = 'pbl-project-overview';

export function ProjectOverview({ view, hero }: { view: LearningView; hero?: ProjectHeroDetails }) {
  const { t } = useI18n();
  const titleId = useId();
  const milestones = view.milestones ?? [];
  const outcome = hero?.learningObjective || milestones.at(-1)?.outcome;
  const steps = milestones[0]?.stages ?? [];

  return (
    <section
      id={PROJECT_OVERVIEW_ID}
      aria-labelledby={titleId}
      className="pbl-project-overview relative min-w-0 rounded-2xl border"
    >
      <header className="relative flex min-w-0 items-center gap-3 p-4">
        <span className="pbl-overview-icon grid size-9 shrink-0 place-items-center rounded-xl border">
          <Map size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <span id={titleId} className="pbl-overview-accent block text-sm font-medium">
            {t('pblV3.overview.title')}
          </span>
          <h3 className="mt-1 break-words text-lg font-semibold leading-snug">
            {hero?.title || view.title}
          </h3>
        </div>
      </header>
      <div className="pbl-overview-content relative space-y-4 px-4 pb-4 text-sm leading-relaxed">
        {hero?.description && (
          <div>
            <h4 className="pbl-overview-label">{t('pblV3.overview.projectGoal')}</h4>
            <p className="mt-1.5">{hero.description}</p>
          </div>
        )}
        {outcome && (
          <div className="pbl-overview-result rounded-xl border p-3">
            <h4 className="pbl-overview-accent text-sm font-semibold">
              {t('pblV3.overview.finishedWork')}
            </h4>
            <p className="mt-1.5 font-medium">{outcome}</p>
          </div>
        )}
        {milestones.length > 0 && (
          <div>
            <h4 className="pbl-overview-label">{t('pblV3.overview.roadmap')}</h4>
            <ol aria-label={t('pblV3.overview.roadmap')} className="mt-2 space-y-2">
              {milestones.map((milestone, index) => {
                const combined = milestone.goal === milestone.outcome;
                return (
                  <li
                    key={milestone.id}
                    className="pbl-overview-milestone flex gap-3 rounded-xl border p-3"
                  >
                    <span className="pbl-overview-icon grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h5 className="text-[15px] font-semibold">
                        {milestone.title}
                        {milestone.optional && (
                          <span className="ms-2 text-xs font-normal">{t('pblV3.optional')}</span>
                        )}
                      </h5>
                      {milestone.goal && (
                        <p className="mt-1.5">
                          <span className="pbl-overview-label me-2">
                            {t(combined ? 'pblV3.overview.goalAndResult' : 'pblV3.overview.goal')}
                          </span>
                          {milestone.goal}
                        </p>
                      )}
                      {milestone.outcome && !combined && (
                        <p className="mt-1.5">
                          <span className="pbl-overview-label me-2">
                            {t('pblV3.overview.result')}
                          </span>
                          {milestone.outcome}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <details className="pbl-overview-guide group border-t pt-3">
          <summary className="pbl-overview-accent flex cursor-pointer list-none items-center justify-between gap-3 rounded-md py-1 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            {t('pblV3.overview.eachStage')}
            <ChevronDown
              size={16}
              className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </summary>
          <div className="space-y-3 pt-2">
            {steps.length > 0 && (
              <div>
                <ol className="mt-2 flex flex-wrap gap-x-2 gap-y-1.5 text-sm">
                  {steps.map((step, index) => (
                    <li key={`${index}:${step}`} className="flex items-center gap-1.5">
                      <span className="pbl-overview-accent tabular-nums">{index + 1}</span>
                      {t(`pblV3.journey.steps.${step}`)}
                      {index < steps.length - 1 && (
                        <span className="pbl-overview-label ms-0.5" aria-hidden="true">
                          ›
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <ul className="space-y-2 text-sm">
              {(
                [
                  [Compass, 'yourRole'],
                  [Monitor, 'preview'],
                  [Route, 'advance'],
                ] as const
              ).map(([Icon, key]) => (
                <li key={key} className="flex items-start gap-2">
                  <Icon
                    size={14}
                    className="pbl-overview-accent mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t(`pblV3.overview.${key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>
    </section>
  );
}
