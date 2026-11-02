'use client';

import { Dialog } from 'radix-ui';
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { learningProgress, learningStep } from '@/lib/pbl/v3/presentation';
import { stepsForWorkbench, type OnboardingStep } from '@/lib/pbl/v3/onboarding';
import type { LearningView } from '@/lib/pbl/v3/types';

const targets: Record<OnboardingStep, string> = {
  welcome: '[data-testid="pbl-v3-workspace"]',
  progress: '[data-pbl-tour="progress"]',
  discussion: '[data-pbl-tour="conversation"]',
  decisions: '[data-pbl-tour="task-trigger"], [data-pbl-tour="task"]',
  plan: '[data-testid="pbl-ide"], [data-pbl-tour="workspace-toggle"]',
  code: '[data-testid="pbl-ide"], [data-pbl-tour="workspace-toggle"]',
  tests: '[data-pbl-tour="task"]',
  quiz: '[data-pbl-tour="task-trigger"], [data-pbl-tour="task"]',
  recap: '[data-pbl-tour="report"], [data-pbl-tour="conversation"]',
  application: '[data-testid="pbl-application-panel"], [data-testid="pbl-application-open"]',
  status: '[data-pbl-tour="environment"]',
  layout: '[data-pbl-tour="workspace-toggle"]',
  return: '[data-pbl-tour="composer"], [data-pbl-tour="task"]',
};

type Box = { x: number; y: number; width: number; height: number };
type Layout = { width: number; height: number; target: Box; card: { x: number; y: number } };

/** A visual tour of the live workspace. No learning commands or preview launches. */
export function WorkbenchOnboarding({
  view,
  root,
  returnFocus,
  onClose,
}: {
  view: LearningView;
  root: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const steps = stepsForWorkbench(view);
  const [index, setIndex] = useState(0);
  const [expandedStep, setExpandedStep] = useState<OnboardingStep | null>(null);
  const stepIndex = Math.min(index, steps.length - 1);
  const step = steps[stepIndex];
  const detailed = expandedStep === step;
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const focusedStep = useRef<OnboardingStep | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const [layout, setLayout] = useState<Layout | null>(null);
  const progress = learningProgress(view);
  const current = `M${view.state.position.milestoneIndex + 1}${progress.total > 0 ? ` · ${progress.current}/${progress.total}` : ''}`;
  const stepName = t(`pblV3.journey.steps.${learningStep(view)}`);
  const copy = (key: string) =>
    t(`pblV3.onboarding.${key}`, { current, step: stepName, total: progress.total });

  useLayoutEffect(() => {
    const owner = root.current;
    const content = card;
    if (!owner || !content) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = owner.getBoundingClientRect();
      if (!owner.clientWidth || !owner.clientHeight || !bounds.width || !bounds.height) return;
      const scaleX = bounds.width / owner.clientWidth;
      const scaleY = bounds.height / owner.clientHeight;
      // The host uses 100vw, while html reserves a scrollbar gutter. Measure
      // the actually visible area rather than placing controls under that clip.
      const width = Math.min(
        owner.clientWidth,
        (Math.min(
          document.documentElement.clientWidth,
          document.documentElement.getBoundingClientRect().right,
        ) -
          bounds.left) /
          scaleX,
      );
      const height = Math.min(owner.clientHeight, (window.innerHeight - bounds.top) / scaleY);
      if (width <= 0 || height <= 0) return;
      const visible = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return (
          // Radix aria-hides the background for assistive technology while
          // this modal is open. Those nodes remain valid visual anchors.
          !element.closest('[hidden], [inert]') &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.right > bounds.left &&
          rect.left < bounds.right &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom
        );
      };
      // Try each selector in priority order; querySelector on a comma-list
      // would choose DOM order instead (e.g. a collapsed application panel).
      const anchor =
        step === 'welcome'
          ? owner
          : (targets[step]
              .split(', ')
              .flatMap((selector) => Array.from(owner.querySelectorAll<HTMLElement>(selector)))
              .find(visible) ??
            owner.querySelector<HTMLElement>('[data-pbl-tour="replay"]') ??
            owner);
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(0, (rect.left - bounds.left) / scaleX - 5);
      const top = Math.max(0, (rect.top - bounds.top) / scaleY - 5);
      const target = {
        x: left,
        y: top,
        width: Math.max(0, Math.min(width, (rect.right - bounds.left) / scaleX + 5) - left),
        height: Math.max(0, Math.min(height, (rect.bottom - bounds.top) / scaleY + 5) - top),
      };
      const cw = content.offsetWidth,
        ch = content.offsetHeight,
        gap = 16,
        edge = 12;
      const clamp = (value: number, max: number) => Math.max(edge, Math.min(value, max - edge));
      const candidates = [
        { x: target.x + target.width + gap, y: target.y },
        { x: target.x - cw - gap, y: target.y },
        { x: target.x + target.width / 2 - cw / 2, y: target.y + target.height + gap },
        { x: target.x + target.width / 2 - cw / 2, y: target.y - ch - gap },
      ].map((position) => ({
        x: clamp(position.x, width - cw),
        y: clamp(position.y, height - ch),
      }));
      const overlap = (position: { x: number; y: number }) =>
        Math.max(
          0,
          Math.min(position.x + cw, target.x + target.width) - Math.max(position.x, target.x),
        ) *
        Math.max(
          0,
          Math.min(position.y + ch, target.y + target.height) - Math.max(position.y, target.y),
        );
      const position =
        step === 'welcome'
          ? { x: Math.max(edge, (width - cw) / 2), y: Math.max(edge, (height - ch) / 2) }
          : candidates.sort((a, b) => overlap(a) - overlap(b))[0];
      const next = { width, height, target, card: position };
      setLayout((prior) => (JSON.stringify(prior) === JSON.stringify(next) ? prior : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(owner);
    resize.observe(content);
    const changes = new MutationObserver(schedule);
    changes.observe(owner, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('fullscreenchange', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      changes.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('fullscreenchange', schedule);
    };
  }, [step, detailed, locale, root, view.revision, card]);

  useLayoutEffect(() => {
    if (layout && focusedStep.current !== step) {
      heading.current?.focus({ preventScroll: true });
      focusedStep.current = step;
    }
  }, [layout, step]);

  const move = (next: number) => {
    setIndex(next);
    setExpandedStep(null);
    body.current?.scrollTo({ top: 0 });
  };
  const button =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40';
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal container={root.current}>
        <Dialog.Overlay className="absolute inset-0 z-[60]" data-pbl-onboarding="overlay">
          <svg
            aria-hidden="true"
            className="pointer-events-none"
            style={{ width: layout?.width ?? '100%', height: layout?.height ?? '100%' }}
            viewBox={layout ? `0 0 ${layout.width} ${layout.height}` : undefined}
            preserveAspectRatio="none"
          >
            <defs>
              <mask id={maskId}>
                <rect width="100%" height="100%" fill="white" />
                {layout && <rect {...layout.target} rx="8" fill="black" />}
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="black"
              fillOpacity="0.68"
              mask={`url(#${maskId})`}
            />
            {layout && (
              <rect
                data-pbl-onboarding="spotlight"
                {...layout.target}
                rx="8"
                fill="none"
                stroke="var(--primary)"
                strokeWidth="2"
              />
            )}
          </svg>
        </Dialog.Overlay>
        <Dialog.Content
          ref={setCard}
          data-pbl-onboarding="card"
          data-step={step}
          dir={locale === 'ar-SA' ? 'rtl' : 'ltr'}
          className="absolute z-[61] flex max-h-[calc(100%-24px)] w-[min(26rem,calc(100%-24px))] flex-col overflow-hidden rounded-2xl border border-primary/30 bg-popover text-popover-foreground shadow-2xl outline-none"
          style={{
            left: layout?.card.x ?? 12,
            top: layout?.card.y ?? 12,
            visibility: layout ? undefined : 'hidden',
            maxWidth: layout ? layout.width - 24 : undefined,
            maxHeight: layout ? layout.height - 24 : undefined,
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const prior = returnFocus.current;
            const target =
              prior?.isConnected &&
              !prior.closest('[inert]') &&
              !prior.matches(':disabled') &&
              prior.getClientRects().length
                ? prior
                : root.current;
            target?.focus({ preventScroll: true });
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
            <BookOpen size={16} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1 text-xs font-medium text-muted-foreground">
              {t('pblV3.onboarding.counter', { current: stepIndex + 1, total: steps.length })}
            </span>
            <Dialog.Close className="rounded-md p-1 hover:bg-muted" aria-label={copy('close')}>
              <X size={16} />
            </Dialog.Close>
          </header>
          <div ref={body} className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
            <Dialog.Title
              ref={heading}
              tabIndex={-1}
              className="text-lg font-semibold leading-snug outline-none"
            >
              {copy(`steps.${step}.title`)}
            </Dialog.Title>
            <Dialog.Description className="whitespace-pre-line text-sm leading-relaxed">
              {copy(`steps.${step}.body`)}
            </Dialog.Description>
            {step === 'progress' && progress.total > 0 && (
              <ol className="flex flex-wrap gap-1.5" aria-label={t('pblV3.journey.milestoneSteps')}>
                {progress.steps.map((item, i) => (
                  <li key={i} className="rounded-md bg-muted px-2 py-1 text-xs">
                    {i + 1}. {t(`pblV3.journey.steps.${item.label}`)}
                  </li>
                ))}
              </ol>
            )}
            {step === 'discussion' && (
              <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed">
                {view.actions.includes('chat') ? copy('chatAvailable') : copy('taskOnly')}
              </p>
            )}
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-primary"
              aria-expanded={detailed}
              aria-controls={`${maskId}-details`}
              onClick={() => setExpandedStep(detailed ? null : step)}
            >
              {copy(detailed ? 'less' : 'more')}
              <ChevronDown size={14} className={detailed ? 'rotate-180' : undefined} />
            </button>
            {detailed && (
              <p
                id={`${maskId}-details`}
                className="whitespace-pre-line rounded-lg bg-muted/60 p-3 text-sm leading-relaxed"
              >
                {copy(`steps.${step}.detail`)}
              </p>
            )}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
            <button
              type="button"
              className={`${button} text-muted-foreground hover:bg-muted`}
              onClick={onClose}
            >
              {copy('skip')}
            </button>
            <div className="flex flex-wrap gap-1">
              {stepIndex > 0 && (
                <button
                  type="button"
                  className={`${button} hover:bg-muted`}
                  onClick={() => move(stepIndex - 1)}
                >
                  <ChevronLeft size={14} />
                  {copy('previous')}
                </button>
              )}
              <button
                type="button"
                className={`${button} bg-primary text-primary-foreground hover:opacity-90`}
                onClick={() => (stepIndex === steps.length - 1 ? onClose() : move(stepIndex + 1))}
              >
                {copy(stepIndex === steps.length - 1 ? 'finish' : 'next')}
                <ChevronRight size={14} />
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
