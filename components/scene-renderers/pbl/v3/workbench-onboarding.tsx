'use client';

import { Dialog } from 'radix-ui';
import { BookOpen, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { stepsForWorkbench, type OnboardingStep } from '@/lib/pbl/v3/onboarding';
import type { LearningView } from '@/lib/pbl/v3/types';

const targets: Record<OnboardingStep, string> = {
  progress: '[data-pbl-tour="task"]',
  discussion: '[data-pbl-tour="conversation"]',
  code: '[data-testid="pbl-ide"], [data-pbl-tour="workspace-toggle"]',
  application: '[data-testid="pbl-application-panel"], [data-testid="pbl-application-open"]',
  replay: '[data-pbl-tour="replay"]',
};

type Box = { x: number; y: number; width: number; height: number };
type Layout = { width: number; height: number; target: Box | null; card: { x: number; y: number } };

/** A visual tour of the live workspace. No learning commands or preview launches. */
export function WorkbenchOnboarding({
  view,
  root,
  returnFocus,
  onFinish,
}: {
  view: LearningView;
  root: RefObject<HTMLElement | null>;
  returnFocus: RefObject<HTMLElement | null>;
  onFinish: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [nativeFullscreen, setNativeFullscreen] = useState(
    () => typeof document !== 'undefined' && !!document.fullscreenElement,
  );
  useEffect(() => {
    const sync = () => setNativeFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const steps = stepsForWorkbench(view);
  const [index, setIndex] = useState(0);
  const stepIndex = Math.min(index, steps.length - 1);
  const step = steps[stepIndex];
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const focusedStep = useRef<OnboardingStep | null>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState(false);
  const finishingRef = useRef(false);
  const finish = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    // Keep keyboard ownership when disabling the clicked/focused button.
    card?.focus({ preventScroll: true });
    setFinishing(true);
    setFinishError(false);
    try {
      await onFinish();
    } catch {
      setFinishError(true);
    } finally {
      finishingRef.current = false;
      setFinishing(false);
    }
  };
  const maskId = useId();
  const [layout, setLayout] = useState<Layout | null>(null);
  const copy = (key: string) => t(`pblV3.onboarding.${key}`);

  useLayoutEffect(() => {
    const owner = root.current;
    const content = card;
    if (!owner || !content) return;
    // Scroll only on entry to this page, never on each stream update/resize.
    // Hidden panels may use their own relevant toggle; never substitute replay.
    const selectors = targets[step].split(', ');
    const findAnchor = () =>
      selectors
        .flatMap((selector) => Array.from(owner.querySelectorAll<HTMLElement>(selector)))
        .find((element) => {
          const rect = element.getBoundingClientRect();
          return !element.closest('[hidden], [inert]') && rect.width > 0 && rect.height > 0;
        });
    findAnchor()?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
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
      const anchor = findAnchor();
      let target: Box | null = null;
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        let left = Math.max(bounds.left, rect.left - 5 * scaleX);
        let right = Math.min(bounds.left + width * scaleX, rect.right + 5 * scaleX);
        let top = Math.max(bounds.top, rect.top - 5 * scaleY);
        let bottom = Math.min(bounds.top + height * scaleY, rect.bottom + 5 * scaleY);
        // A stacked panel may be larger than its scroll viewport. The spotlight
        // must obey the same clipping ancestors as the actual region.
        for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const clip = parent.getBoundingClientRect();
          const sx = parent.offsetWidth ? clip.width / parent.offsetWidth : 1;
          const sy = parent.offsetHeight ? clip.height / parent.offsetHeight : 1;
          if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
            const edge = clip.left + parent.clientLeft * sx;
            left = Math.max(left, edge);
            right = Math.min(right, edge + parent.clientWidth * sx);
          }
          if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
            const edge = clip.top + parent.clientTop * sy;
            top = Math.max(top, edge);
            bottom = Math.min(bottom, edge + parent.clientHeight * sy);
          }
          if (parent === owner) break;
        }
        if (right > left && bottom > top)
          target = {
            x: (left - bounds.left) / scaleX,
            y: (top - bounds.top) / scaleY,
            width: (right - left) / scaleX,
            height: (bottom - top) / scaleY,
          };
      }
      const cw = content.offsetWidth,
        ch = content.offsetHeight,
        gap = 16,
        edge = 12;
      const clamp = (value: number, max: number) => Math.max(edge, Math.min(value, max - edge));
      const positions = target
        ? [
            { x: target.x + target.width + gap, y: target.y },
            { x: target.x - cw - gap, y: target.y },
            { x: target.x + target.width / 2 - cw / 2, y: target.y + target.height + gap },
            { x: target.x + target.width / 2 - cw / 2, y: target.y - ch - gap },
          ]
        : [];
      const candidates = positions.map((position) => ({
        x: clamp(position.x, width - cw),
        y: clamp(position.y, height - ch),
      }));
      const overlap = (position: { x: number; y: number }) =>
        target
          ? Math.max(
              0,
              Math.min(position.x + cw, target.x + target.width) - Math.max(position.x, target.x),
            ) *
            Math.max(
              0,
              Math.min(position.y + ch, target.y + target.height) - Math.max(position.y, target.y),
            )
          : 0;
      const position = !target
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
  }, [step, locale, root, card]);

  useLayoutEffect(() => {
    if (layout && focusedStep.current !== step) {
      nextButton.current?.focus({ preventScroll: true });
      focusedStep.current = step;
    }
  }, [layout, step]);

  const move = (next: number) => {
    setIndex(next);
    body.current?.scrollTo({ top: 0 });
  };
  const button =
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40';
  return (
    <Dialog.Root open>
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
                {layout?.target && <rect {...layout.target} rx="8" fill="black" />}
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="black"
              fillOpacity="0.68"
              mask={`url(#${maskId})`}
            />
            {layout?.target && (
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
          // Recreate Radix's focus/aria boundary after the host reparents for native fullscreen.
          // Step state stays in this component; the workbench and preview stay mounted.
          key={nativeFullscreen ? 'native' : 'page'}
          ref={setCard}
          tabIndex={-1}
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
            if (finishing && event.target instanceof HTMLElement)
              event.target.focus({ preventScroll: true });
            else nextButton.current?.focus({ preventScroll: true });
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
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void finish();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-5 py-3">
            <BookOpen size={16} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="flex-1 text-xs font-medium text-muted-foreground">
              {t('pblV3.onboarding.counter', { current: stepIndex + 1, total: steps.length })}
            </span>
            <button
              type="button"
              aria-label={copy('close')}
              disabled={finishing}
              className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
              onClick={() => void finish()}
            >
              <X size={16} />
            </button>
          </header>
          <div ref={body} className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
            <Dialog.Title
              aria-live="polite"
              aria-atomic="true"
              className="text-lg font-semibold leading-snug outline-none"
            >
              {copy(`steps.${step}.title`)}
            </Dialog.Title>
            <Dialog.Description className="whitespace-pre-line text-sm leading-relaxed">
              {copy(`steps.${step}.body`)}
            </Dialog.Description>
            {finishError && (
              <p role="alert" className="text-sm text-destructive">
                {copy('finishError')}
              </p>
            )}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            <div className="flex flex-wrap gap-1">
              {stepIndex > 0 && (
                <button
                  type="button"
                  className={`${button} hover:bg-muted`}
                  disabled={finishing}
                  onClick={() => move(stepIndex - 1)}
                >
                  <ChevronLeft size={14} />
                  {copy('previous')}
                </button>
              )}
              <button
                ref={nextButton}
                type="button"
                className={`${button} bg-primary text-primary-foreground hover:opacity-90`}
                disabled={finishing}
                aria-busy={finishing}
                onClick={() => {
                  if (stepIndex === steps.length - 1) void finish();
                  else move(stepIndex + 1);
                }}
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
