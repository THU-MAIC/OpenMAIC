'use client';

import { ChevronDown, Compass, Map, Monitor, Route } from 'lucide-react';
import { useId, type Ref } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import type { LearningView } from '@/lib/pbl/v3/types';

export type ProjectOverviewMode = 'closed' | 'details';
export const PROJECT_OVERVIEW_ID = 'pbl-project-overview';

export function ProjectOverview({
  view,
  hero,
  mode,
  onChange,
  triggerRef,
}: {
  view: LearningView;
  hero?: ProjectHeroDetails;
  mode: ProjectOverviewMode;
  onChange: (mode: ProjectOverviewMode) => void;
  triggerRef: Ref<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  const contentId = useId();
  const titleId = useId();
  const open = mode === 'details';
  const milestones = view.milestones ?? [];
  const outcome = hero?.learningObjective || milestones.at(-1)?.outcome;
  const steps = milestones[0]?.stages ?? [];
  const toggle = () => onChange(open ? 'closed' : 'details');

  return (
    <section
      id={PROJECT_OVERVIEW_ID}
      aria-labelledby={titleId}
      data-mode={mode}
      className="pbl-project-overview relative min-w-0 rounded-2xl border"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
        className="pbl-overview-trigger relative flex w-full min-w-0 items-center gap-3 rounded-2xl p-4 text-start"
      >
        <span className="pbl-overview-icon grid size-9 shrink-0 place-items-center rounded-xl border">
          <Map size={18} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span
            id={titleId}
            className="pbl-overview-accent block text-[11px] font-semibold tracking-wide"
          >
            {t('pblV3.overview.title')}
          </span>
          <span className="mt-1 block break-words text-sm font-semibold leading-snug">
            {hero?.title || view.title}
          </span>
        </span>
        <span className="pbl-overview-accent flex shrink-0 items-center gap-1 text-xs font-medium">
          {t(open ? 'pblV3.overview.collapse' : 'pblV3.overview.expand')}
          <ChevronDown size={15} className={open ? 'rotate-180' : ''} aria-hidden="true" />
        </span>
      </button>
      <div id={contentId} hidden={!open}>
        {open && (
          <div className="pbl-overview-content relative space-y-4 px-4 pb-4 text-[13px] leading-relaxed">
            {hero?.description && (
              <div>
                <h4 className="pbl-overview-label">{t('pblV3.overview.projectGoal')}</h4>
                <p className="mt-1.5">{hero.description}</p>
              </div>
            )}
            {outcome && (
              <div className="pbl-overview-result rounded-xl border p-3">
                <h4 className="pbl-overview-accent text-xs font-semibold">
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
                          <h5 className="font-semibold">
                            {milestone.title}
                            {milestone.optional && (
                              <span className="ms-2 text-xs font-normal">
                                {t('pblV3.optional')}
                              </span>
                            )}
                          </h5>
                          {milestone.goal && (
                            <p className="mt-1.5">
                              <span className="pbl-overview-label me-2">
                                {t(
                                  combined ? 'pblV3.overview.goalAndResult' : 'pblV3.overview.goal',
                                )}
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
            <div className="pbl-overview-guide space-y-3 border-t pt-3">
              {steps.length > 0 && (
                <div>
                  <h4 className="pbl-overview-label">{t('pblV3.overview.eachStage')}</h4>
                  <ol className="mt-2 flex flex-wrap gap-x-2 gap-y-1.5 text-xs">
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
              <ul className="space-y-2 text-xs">
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
              <button
                type="button"
                onClick={() => onChange('closed')}
                className="pbl-overview-accent rounded-md text-xs font-semibold underline-offset-4 hover:underline"
              >
                {t('pblV3.overview.collapse')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
