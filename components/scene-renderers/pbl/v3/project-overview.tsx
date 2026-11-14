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
  const outcome = hero?.finishedWork;
  const steps = milestones[0]?.stages ?? [];

  return (
    <section
      id={PROJECT_OVERVIEW_ID}
      aria-labelledby={titleId}
      className="pbl-project-overview relative min-w-0 rounded-2xl border"
    >
      <header className="relative flex min-w-0 items-center gap-2.5 px-3.5 pb-2 pt-3">
        <span className="pbl-overview-icon grid size-9 shrink-0 place-items-center rounded-xl border">
          <Map size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <span id={titleId} className="pbl-overview-accent block text-sm font-medium">
            {t('pblV3.overview.title')}
          </span>
          <h3 className="mt-0.5 break-words text-lg font-semibold leading-snug">
            {hero?.title || view.title}
          </h3>
        </div>
      </header>
      <div className="pbl-overview-content relative space-y-3 px-3.5 pb-3 text-sm leading-[1.55]">
        {hero?.description && (
          <div>
            <h4 className="pbl-overview-label me-2 inline">{t('pblV3.overview.projectGoal')}</h4>
            <p className="inline">{hero.description}</p>
          </div>
        )}
        {outcome && (
          <div className="pbl-overview-result rounded-xl border p-2.5">
            <h4 className="pbl-overview-accent me-2 inline text-sm font-semibold">
              {t('pblV3.overview.finishedWork')}
            </h4>
            <p className="inline font-medium">{outcome}</p>
          </div>
        )}
        {milestones.length > 0 && (
          <div>
            <h4 className="pbl-overview-label">{t('pblV3.overview.roadmap')}</h4>
            <ol
              aria-label={t('pblV3.overview.roadmap')}
              className="pbl-overview-roadmap mt-1.5 grid gap-2"
            >
              {milestones.map((milestone, index) => {
                const combined = milestone.goal === milestone.outcome;
                return (
                  <li
                    key={milestone.id}
                    className="pbl-overview-milestone min-w-0 rounded-xl border p-2.5"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="pbl-overview-icon grid size-5 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums">
                        {index + 1}
                      </span>
                      <h5 className="text-[15px] font-semibold">
                        {milestone.title}
                        {milestone.optional && (
                          <span className="ms-2 text-xs font-normal">{t('pblV3.optional')}</span>
                        )}
                      </h5>
                    </div>
                    <div className="space-y-1">
                      {milestone.goal && (
                        <p>
                          <span className="pbl-overview-label me-2">
                            {t(combined ? 'pblV3.overview.goalAndResult' : 'pblV3.overview.goal')}
                          </span>
                          {milestone.goal}
                        </p>
                      )}
                      {milestone.outcome && !combined && (
                        <p>
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
        <details className="pbl-overview-guide group">
          <summary className="pbl-overview-accent flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-xl border px-3 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <span>{t('pblV3.overview.eachStage')}</span>
            <span className="pbl-overview-disclosure flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold">
              <span className="group-open:hidden">{t('pblV3.overview.expand')}</span>
              <span className="hidden group-open:inline">{t('pblV3.overview.collapse')}</span>
              <ChevronDown
                size={16}
                className="transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
              />
            </span>
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
