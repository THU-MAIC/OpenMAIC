'use client';
import {
  useEffect,
  useId,
  useRef,
  useState,
  useImperativeHandle,
  type ReactNode,
  type Ref,
} from 'react';
import { ChevronUp, Settings, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  continueActionLabel,
  hasTaskDrawer,
  learningProgress,
  learningStep,
} from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';

export interface TaskDockHandle {
  open: () => void;
}

/** Task details float over the transcript; they never push the composer out of view. */
export function TaskDock({
  view,
  children,
  action,
  summary,
  working = false,
  modalActive = false,
  actionDisabled = false,
  ref,
}: {
  view: LearningView;
  children: ReactNode;
  action: ReactNode;
  summary?: ReactNode;
  working?: boolean;
  modalActive?: boolean;
  actionDisabled?: boolean;
  ref?: Ref<TaskDockHandle>;
}) {
  const { t } = useI18n();
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const key = `${view.id}:${view.state.position.milestoneId}:${view.state.position.stageIndex}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const hasDrawer = hasTaskDrawer(view);
  const open = hasDrawer && openKey === key;
  const progress = learningProgress(view);
  const step = learningStep(view);
  const milestone = view.milestones?.find((item) => item.id === view.state.position.milestoneId);
  const running = view.busy || working;
  const canAdvance = view.actions.includes('next');
  const ready = canAdvance && !running;
  const [attentionDismissed, setAttentionDismissed] = useState(false);
  const attention = ready && !actionDisabled && !modalActive && !attentionDismissed;
  useEffect(() => {
    if (!attention) return;
    const timeout = window.setTimeout(() => setAttentionDismissed(true), 8_000);
    return () => window.clearTimeout(timeout);
  }, [attention]);
  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        if (!hasDrawer) return;
        setOpenKey(key);
        drawer.current?.focus({ preventScroll: true });
      },
    }),
    [hasDrawer, key],
  );
  useEffect(() => {
    if (open && !modalActive) drawer.current?.focus({ preventScroll: true });
  }, [open, modalActive]);
  const hint = t(
    view.state.status === 'completed'
      ? 'pblV3.completed'
      : view.busy
        ? 'pblV3.thinking'
        : canAdvance
          ? 'pblV3.journey.ready'
          : `pblV3.journey.hints.${step}`,
    { action: continueActionLabel(view, t) },
  );
  const close = () => {
    setOpenKey(null);
    toggle.current?.focus();
  };
  useEffect(() => {
    if (!open || modalActive) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenKey(null);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, modalActive]);
  const copy = (
    <>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-primary' : ready ? 'bg-primary' : 'bg-muted-foreground'}`}
      />
      <strong className="pbl-task-step min-w-0 truncate">{t(`pblV3.journey.steps.${step}`)}</strong>
      {(summary || !ready) && (
        <span
          className={`${summary ? 'order-last basis-full' : 'pbl-task-hint flex-1'} min-w-0 truncate text-muted-foreground`}
          title={hint}
        >
          {summary ?? hint}
        </span>
      )}
    </>
  );
  return (
    <section
      data-pbl-tour="task"
      className="pbl-task-dock relative shrink-0 border-t bg-background"
      aria-label={t('pblV3.journey.currentTask')}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {open && (
        <div
          ref={drawer}
          id={id}
          tabIndex={-1}
          hidden={!open}
          role="region"
          aria-label={t('pblV3.journey.taskDetails')}
          className="pbl-task-drawer absolute inset-x-2 bottom-[calc(100%+8px)] z-20 flex flex-col overflow-hidden rounded-lg border bg-popover text-sm shadow-xl outline-none"
        >
          <header className="flex h-[42px] shrink-0 items-center gap-2 border-b px-3">
            <Settings size={16} className="text-muted-foreground" />
            <h4 className="font-semibold">{t('pblV3.journey.taskTitle')}</h4>
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              M{view.state.position.milestoneIndex + 1}
              {progress.total > 0 && (
                <>
                  {' '}
                  · {progress.current}/{progress.total}
                </>
              )}
            </span>
            <button
              type="button"
              className="rounded p-1 hover:bg-muted"
              onClick={close}
              aria-label={t('pblV3.journey.closeDetails')}
            >
              <X size={16} />
            </button>
          </header>
          <div className="grid min-h-0 content-start gap-3 overflow-y-auto p-3 leading-[1.5]">
            {milestone && (
              <section
                data-testid="pbl-current-milestone-summary"
                aria-label={milestone.title}
                className="pbl-milestone-summary rounded-xl border p-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="pbl-milestone-caption rounded-md px-2 py-1 text-xs font-semibold">
                    {t('pblV3.journey.currentMilestone')}
                  </span>
                  <h4 className="text-[15px] font-semibold leading-snug">{milestone.title}</h4>
                </div>
                <dl className="mt-2 space-y-1.5 leading-relaxed">
                  {milestone.goal && (
                    <div>
                      <dt className="pbl-milestone-label inline font-semibold">
                        {t('pblV3.journey.milestoneGoal')}
                      </dt>
                      <dd className="ms-1 inline">{milestone.goal}</dd>
                    </div>
                  )}
                  {milestone.outcome && (
                    <div>
                      <dt className="pbl-milestone-label inline font-semibold">
                        {t('pblV3.journey.milestoneResult')}
                      </dt>
                      <dd className="ms-1 inline">{milestone.outcome}</dd>
                    </div>
                  )}
                </dl>
              </section>
            )}
            <div className="grid gap-0.5">
              <strong className="font-semibold">{t(`pblV3.journey.steps.${step}`)}</strong>
              <p className="text-xs text-muted-foreground">{t(`pblV3.journey.hints.${step}`)}</p>
            </div>
            {children}
          </div>
        </div>
      )}
      <div
        className={`flex ${canAdvance ? 'min-h-8' : summary ? 'min-h-12' : 'h-10'} items-center gap-2 px-3 ${canAdvance ? 'py-1' : 'py-2'}`}
      >
        <details
          className="relative shrink-0 text-xs"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
              event.stopPropagation();
            }
          }}
        >
          <summary
            data-pbl-tour="progress"
            className="cursor-pointer list-none rounded px-1 py-1 text-muted-foreground hover:bg-muted"
            aria-label={t('pblV3.journey.milestoneSteps')}
          >
            M{view.state.position.milestoneIndex + 1}
            {progress.total > 0 && (
              <>
                {' '}
                ·{' '}
                <span>
                  {progress.current}/{progress.total}
                </span>
              </>
            )}
          </summary>
          <ol className="absolute bottom-[calc(100%+8px)] left-0 z-30 max-h-[min(20rem,50dvh)] w-max max-w-[75vw] overflow-y-auto rounded-lg border bg-popover p-2 shadow-lg">
            {progress.steps.map((item, index) => (
              <li
                key={index}
                aria-current={item.active ? 'step' : undefined}
                className={`rounded px-2 py-1.5 ${item.active ? 'font-semibold text-primary' : 'text-muted-foreground'}`}
              >
                {item.complete ? '✓' : index + 1}. {t(`pblV3.journey.steps.${item.label}`)}
              </li>
            ))}
          </ol>
        </details>
        {canAdvance && (
          <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</div>
        )}
        {hasDrawer ? (
          <button
            data-pbl-tour="task-trigger"
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={t('pblV3.journey.taskTitle')}
            className={`pbl-task-trigger flex min-w-0 rounded-md px-2 py-1 hover:bg-accent ${canAdvance ? 'shrink-0 gap-1.5 text-muted-foreground' : summary ? 'flex-1 flex-wrap gap-x-2 gap-y-0.5' : 'flex-1 gap-2'} items-center text-left text-xs`}
            onClick={() => setOpenKey(open ? null : key)}
          >
            {canAdvance ? (
              <>
                <Settings size={12} aria-hidden="true" />
                <span>{t('pblV3.journey.reviewDetails')}</span>
              </>
            ) : (
              <>
                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                  {t('pblV3.journey.taskTitle')}
                </span>
                {copy}
              </>
            )}
            <ChevronUp
              size={13}
              className={`shrink-0 ${canAdvance ? 'text-muted-foreground' : 'text-primary'} transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            />
          </button>
        ) : (
          !canAdvance && (
            <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">{copy}</div>
          )
        )}
        {!canAdvance && action}
      </div>
      {canAdvance && action && (
        <div
          data-testid="pbl-advance-bar"
          data-attention={attention ? 'true' : 'false'}
          data-ready={ready && !actionDisabled ? 'true' : 'false'}
          className="pbl-advance-bar mx-3 mb-2 min-w-0 rounded-lg"
          onPointerEnter={() => setAttentionDismissed(true)}
          onFocusCapture={() => setAttentionDismissed(true)}
          onPointerDownCapture={() => setAttentionDismissed(true)}
        >
          {action}
        </div>
      )}
    </section>
  );
}
