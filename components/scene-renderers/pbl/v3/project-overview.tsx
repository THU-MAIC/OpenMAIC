'use client';

import { ArrowDownRight, ChevronDown, Map, X } from 'lucide-react';
import { useId, type Ref } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { ProjectHeroDetails } from '@/lib/pbl/project-hero';
import { learningStep } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';

export type ProjectOverviewMode = 'closed' | 'summary' | 'details';
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
  const open = mode !== 'closed';
  const details = mode === 'details';
  const milestones = view.milestones ?? [];
  const goal = view.task?.goal;
  const description = hero?.description;
  const gains = hero?.gains ?? [];
  const title = t('pblV3.overview.title');

  return (
    <section
      id={PROJECT_OVERVIEW_ID}
      aria-labelledby={titleId}
      data-mode={mode}
      className="pbl-project-overview mx-3 mb-1 shrink-0 rounded-xl border bg-card"
    >
      <header className="flex min-w-0 items-center gap-1 px-2 py-1">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => onChange(open ? 'closed' : 'details')}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start text-xs font-semibold hover:bg-primary/10"
        >
          <Map size={15} className="shrink-0 text-primary" aria-hidden="true" />
          <span id={titleId} className="min-w-0 flex-1 break-words">
            {title}
          </span>
          {!open && <ChevronDown size={15} className="shrink-0" aria-hidden="true" />}
        </button>
        {open && (
          <button
            type="button"
            aria-label={t('pblV3.overview.close')}
            onClick={() => onChange('closed')}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-primary/10 hover:text-foreground"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </header>
      <div id={contentId} hidden={!open}>
        {open && (
          <div className="pbl-overview-content space-y-2.5 overflow-y-auto px-3 pb-3 text-xs">
            <div>
              <h4 className="font-semibold">{hero?.title || view.title}</h4>
              {description && (
                <p
                  className={
                    details
                      ? 'mt-1 text-muted-foreground'
                      : 'mt-1 line-clamp-2 text-muted-foreground'
                  }
                >
                  {description}
                </p>
              )}
            </div>
            {view.state.status !== 'completed' && (
              <div className="space-y-1 rounded-lg border border-primary/20 bg-primary/8 px-2.5 py-2 leading-relaxed">
                <p>
                  <span className="me-1.5 text-muted-foreground">
                    {t('pblV3.journey.currentTask')}
                  </span>
                  <strong className="font-semibold text-primary">
                    {t(`pblV3.journey.steps.${learningStep(view)}`)}
                  </strong>
                </p>
                {goal && (
                  <p className={details ? undefined : 'line-clamp-2'}>
                    <span className="me-1.5 text-muted-foreground">
                      {t('pblV3.overview.currentGoal')}
                    </span>
                    {goal}
                  </p>
                )}
              </div>
            )}
            {details && milestones.length > 0 && (
              <ol aria-label={t('pbl.v2.sidebar.title')} className="space-y-1.5">
                {milestones.map((milestone, index) => {
                  const current =
                    milestone.id === view.state.position.milestoneId &&
                    view.state.status !== 'completed';
                  return (
                    <li
                      key={milestone.id}
                      aria-current={current ? 'step' : undefined}
                      className="flex items-start gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5 aria-[current=step]:bg-primary/10 aria-[current=step]:font-semibold"
                    >
                      <span className="shrink-0 tabular-nums text-primary">{index + 1}</span>
                      <span className="min-w-0 break-words">{milestone.title}</span>
                      {milestone.optional && (
                        <span className="ms-auto text-muted-foreground">{t('pblV3.optional')}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {details && gains.length > 0 && (
              <div>
                <h4 className="font-semibold">{t('pbl.v2.hero.youWillLearn')}</h4>
                <ul className="mt-1 list-disc space-y-1 ps-4 text-muted-foreground">
                  {gains.map((gain) => (
                    <li key={gain}>{gain}</li>
                  ))}
                </ul>
              </div>
            )}
            {!details && (
              <button
                type="button"
                onClick={() => onChange('details')}
                className="inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-md font-semibold text-primary hover:underline"
              >
                <ArrowDownRight
                  size={14}
                  className="shrink-0 rtl:-scale-x-100"
                  aria-hidden="true"
                />
                {t('pblV3.overview.view', {
                  count: milestones.length || hero?.milestoneCount || 1,
                })}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
