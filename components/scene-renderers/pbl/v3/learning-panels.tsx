'use client';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LearningView } from '@/lib/pbl/v3/types';
import { learningProgress } from '@/lib/pbl/v3/presentation';

export function LearningPanels({ view }: { view: LearningView }) {
  const { t } = useI18n();
  const progress = learningProgress(view);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <div className="contents">
      <div ref={wrap} className="relative flex min-w-0 items-center text-xs">
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          aria-label={t('pblV3.learningPath')}
          title={`M${view.state.position.milestoneIndex + 1} · ${view.milestones?.[view.state.position.milestoneIndex]?.title ?? ''}`}
          onClick={() => setOpen(!open)}
          className="inline-flex h-7 items-center gap-2 rounded-md bg-muted px-3 hover:bg-accent"
        >
          <strong className="font-mono">M{view.state.position.milestoneIndex + 1}</strong>
          <span className="flex gap-0.5" aria-hidden="true">
            {progress.steps.map((step, index) => (
              <i
                key={index}
                className={`h-1 w-2 rounded-full ${step.complete || step.active ? 'bg-primary' : 'bg-muted-foreground/25'}`}
              />
            ))}
          </span>
          {progress.total > 0 && (
            <span className="font-mono text-muted-foreground">
              {progress.current}/{progress.total}
            </span>
          )}
        </button>
        {open && (
          <nav
            aria-label={t('pblV3.learningPath')}
            className="absolute right-0 top-[calc(100%+6px)] z-30 max-h-[min(24rem,60dvh)] w-max min-w-64 max-w-[min(32rem,80vw)] overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg"
          >
            <h3 className="border-b px-3 py-2 text-xs font-semibold text-muted-foreground">
              {t('pblV3.learningPath')}
            </h3>
            <ol className="py-1">
              {view.milestones?.map((m, i) => {
                const status = view.state.milestones.find(
                  (item) => item.milestoneId === m.id,
                )?.status;
                const active = i === view.state.position.milestoneIndex;
                const done = status === 'completed';
                return (
                  <li
                    key={m.id}
                    aria-current={active ? 'step' : undefined}
                    data-state={done ? 'done' : active ? 'active' : 'pending'}
                    className={`flex min-h-8 items-center gap-2 rounded-md px-3 py-1 ${active ? 'font-semibold' : 'text-muted-foreground'}`}
                    title={`M${i + 1} · ${m.title}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${done ? 'bg-emerald-500' : active ? 'bg-primary' : 'bg-muted-foreground/25'}`}
                    />
                    <span className="shrink-0 font-mono text-muted-foreground">M{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{m.title}</span>
                    {active && (
                      <span className="shrink-0 font-mono font-normal text-muted-foreground">
                        {progress.current}/{progress.total}
                      </span>
                    )}
                    {done && <Check size={12} aria-label={t('pblV3.completed')} />}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
      </div>
    </div>
  );
}
