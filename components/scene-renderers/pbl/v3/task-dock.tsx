'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronUp, Settings, X } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { hasTaskDrawer, learningProgress, learningStep } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';

/** Task details float over the transcript; they never push the composer out of view. */
export function TaskDock({
  view,
  children,
  action,
  summary,
  working = false,
}: {
  view: LearningView;
  children: ReactNode;
  action: ReactNode;
  summary?: ReactNode;
  working?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const key = `${view.id}:${view.state.position.milestoneId}:${view.state.position.stageIndex}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const hasDrawer = hasTaskDrawer(view);
  const open = hasDrawer && openKey === key;
  const progress = learningProgress(view);
  const step = learningStep(view);
  const running = view.busy || working;
  const ready = view.actions.includes('next') && !running;
  const hint = t(
    view.state.status === 'completed'
      ? 'pblV3.completed'
      : view.busy
        ? 'pblV3.thinking'
        : view.actions.includes('next')
          ? 'pblV3.journey.ready'
          : `pblV3.journey.hints.${step}`,
  );
  const close = () => {
    setOpenKey(null);
    toggle.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenKey(null);
        toggle.current?.focus();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open]);
  const copy = (
    <>
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-primary' : ready ? 'bg-primary' : 'bg-muted-foreground'}`}
      />
      <strong className="shrink-0">{t(`pblV3.journey.steps.${step}`)}</strong>
      <span
        className={`${summary ? 'order-last basis-full' : 'flex-1'} min-w-0 truncate text-muted-foreground`}
        title={hint}
      >
        {summary ?? hint}
      </span>
    </>
  );
  return (
    <section
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
          id={id}
          hidden={!open}
          role="region"
          aria-label={t('pblV3.journey.taskDetails')}
          className="pbl-task-drawer absolute inset-x-2 bottom-[calc(100%+8px)] z-20 flex flex-col overflow-hidden rounded-lg border bg-popover text-sm shadow-xl"
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
            <div className="grid gap-0.5">
              <strong className="font-semibold">{t(`pblV3.journey.steps.${step}`)}</strong>
              <p className="text-xs text-muted-foreground">{t(`pblV3.journey.hints.${step}`)}</p>
            </div>
            {children}
          </div>
        </div>
      )}
      <div className={`flex ${summary ? 'min-h-12' : 'h-10'} items-center gap-2 px-3 py-2`}>
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
        {hasDrawer ? (
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={id}
            className={`flex min-w-0 flex-1 ${summary ? 'flex-wrap gap-x-2 gap-y-0.5' : 'gap-2'} items-center text-left text-xs`}
            onClick={() => setOpenKey(open ? null : key)}
          >
            {copy}
            <ChevronUp
              size={13}
              className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            />
            <span className="sr-only">{t('pblV3.journey.taskDetails')}</span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">{copy}</div>
        )}
        {action}
      </div>
    </section>
  );
}
