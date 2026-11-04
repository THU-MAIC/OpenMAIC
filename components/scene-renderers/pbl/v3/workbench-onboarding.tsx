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
type Layout = {
  width: number;
  height: number;
  target: Box | null;
  highlights: Box[];
  card: { x: number; y: number };
  cardMaxHeight: number;
};

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
  onFinish: () => void;
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
  const readingTouchY = useRef<number | null>(null);
  const maskId = useId();
  const [layout, setLayout] = useState<Layout | null>(null);
  const copy = (key: string) => t(`pblV3.onboarding.${key}`);
  // The modal retains focus and blocks actions. Reading the highlighted
  // conversation is safe, so forward only scroll gestures inside its viewport.
  const scrollReading = (x: number, y: number, delta: number, mode = 0) => {
    if (step !== 'discussion') return false;
    const viewport = root.current?.querySelector<HTMLElement>('.pbl-conversation-scroll');
    if (!viewport) return false;
    const bounds = viewport.getBoundingClientRect();
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return false;
    const unit = mode === 1 ? 16 : mode === 2 ? viewport.clientHeight : 1;
    viewport.scrollBy({ top: delta * unit, behavior: 'instant' });
    return true;
  };

  useLayoutEffect(() => {
    const owner = root.current;
    const content = card;
    if (!owner || !content) return;
    // Scroll only on entry to this page, never on each stream update/resize.
    // Hidden panels may use their own relevant toggle; never substitute replay.
    const selectors = targets[step].split(', ');
    const findAnchors = () =>
      selectors
        .flatMap((selector) => Array.from(owner.querySelectorAll<HTMLElement>(selector)))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return !element.closest('[hidden], [inert]') && rect.width > 0 && rect.height > 0;
        });
    findAnchors()[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
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
      const anchors = findAnchors();
      const anchor = anchors[0];
      const visibleBox = (anchor: HTMLElement): Box | null => {
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
          return {
            x: (left - bounds.left) / scaleX,
            y: (top - bounds.top) / scaleY,
            width: (right - left) / scaleX,
            height: (bottom - top) / scaleY,
          };
        return null;
      };
      const target = anchor ? visibleBox(anchor) : null;
      const highlights = (step === 'application' ? anchors : anchors.slice(0, 1))
        .map(visibleBox)
        .filter((box): box is Box => box !== null);
      const cw = content.offsetWidth,
        ch = content.offsetHeight,
        gap = 16,
        edge = 12;
      const compactDiscussion = step === 'discussion' && width < 640;
      const reading = compactDiscussion
        ? anchor?.querySelector('.pbl-conversation-scroll')?.getBoundingClientRect()
        : undefined;
      const cardMaxHeight = compactDiscussion
        ? Math.max(
            160,
            Math.min(
              height - 24,
              reading ? (reading.top - bounds.top) / scaleY - 2 * edge : height / 2,
            ),
          )
        : height - 24;
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
      // Leave the whole reading viewport clear, including later paragraphs
      // and a closing question that arrives while the welcome is streaming.
      const position = compactDiscussion
        ? { x: Math.max(edge, (width - cw) / 2), y: edge }
        : !target
          ? { x: Math.max(edge, (width - cw) / 2), y: Math.max(edge, (height - ch) / 2) }
          : candidates.sort((a, b) => overlap(a) - overlap(b))[0];
      const next = { width, height, target, highlights, card: position, cardMaxHeight };
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
    'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40 max-[360px]:px-2 max-[360px]:text-xs';
  return (
    <Dialog.Root open>
      <Dialog.Portal container={root.current}>
        <Dialog.Overlay
          className="absolute inset-0 z-[60]"
          data-pbl-onboarding="overlay"
          onWheel={(event) =>
            scrollReading(event.clientX, event.clientY, event.deltaY, event.deltaMode)
          }
          onTouchStart={(event) => {
            const point = event.touches.length === 1 ? event.touches[0] : null;
            readingTouchY.current =
              point && scrollReading(point.clientX, point.clientY, 0) ? point.clientY : null;
          }}
          onTouchMove={(event) => {
            const point = event.touches.length === 1 ? event.touches[0] : null;
            if (point && readingTouchY.current !== null) {
              scrollReading(point.clientX, point.clientY, readingTouchY.current - point.clientY);
              readingTouchY.current = point.clientY;
            }
          }}
          onTouchEnd={() => {
            readingTouchY.current = null;
          }}
          onTouchCancel={() => {
            readingTouchY.current = null;
          }}
        >
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
                {layout?.highlights.map((highlight, index) => (
                  <rect key={index} {...highlight} rx="8" fill="black" />
                ))}
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="black"
              fillOpacity="0.68"
              mask={`url(#${maskId})`}
            />
            {layout?.highlights.map((highlight, index) => (
              <rect
                key={index}
                data-pbl-onboarding="spotlight"
                {...highlight}
                rx="8"
                fill="none"
                stroke="var(--primary)"
                strokeWidth="2"
              />
            ))}
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
            maxHeight: layout?.cardMaxHeight,
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nextButton.current?.focus({ preventScroll: true });
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
            onFinish();
          }}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-2 border-b px-5 py-3 max-[360px]:absolute max-[360px]:end-2 max-[360px]:top-2 max-[360px]:z-10 max-[360px]:border-0 max-[360px]:p-0">
            <BookOpen
              size={16}
              className="shrink-0 text-primary max-[360px]:hidden"
              aria-hidden="true"
            />
            <span className="flex-1 text-xs font-medium text-muted-foreground max-[360px]:hidden">
              {t('pblV3.onboarding.counter', { current: stepIndex + 1, total: steps.length })}
            </span>
            <button
              type="button"
              aria-label={copy('close')}
              className="rounded-md p-1 hover:bg-muted disabled:opacity-40"
              onClick={onFinish}
            >
              <X size={16} />
            </button>
          </header>
          <div
            ref={body}
            className="min-h-0 space-y-4 overflow-y-auto px-5 py-4 max-[360px]:space-y-2 max-[360px]:px-4 max-[360px]:py-3"
          >
            <Dialog.Title
              aria-live="polite"
              aria-atomic="true"
              className="text-lg font-semibold leading-snug outline-none max-[360px]:pe-7 max-[360px]:text-base"
            >
              {copy(`steps.${step}.title`)}
            </Dialog.Title>
            <Dialog.Description className="whitespace-pre-line text-sm leading-relaxed">
              {copy(`steps.${step}.body`)}
            </Dialog.Description>
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-4 py-3 max-[360px]:px-3 max-[360px]:py-2">
            <span
              className="me-auto hidden text-xs text-muted-foreground max-[360px]:block"
              aria-label={t('pblV3.onboarding.counter', {
                current: stepIndex + 1,
                total: steps.length,
              })}
            >
              {stepIndex + 1}/{steps.length}
            </span>
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
                ref={nextButton}
                type="button"
                className={`${button} bg-primary text-primary-foreground hover:opacity-90`}
                onClick={() => {
                  if (stepIndex === steps.length - 1) onFinish();
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
