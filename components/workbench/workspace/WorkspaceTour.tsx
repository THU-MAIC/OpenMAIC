'use client';

/**
 * The first-run tour: a dimmed workspace with one area lit at a time and a card
 * beside it, walking a first visit through the workbench and ending on example
 * prompts that start a course.
 *
 * The steps are data (`tour-steps.tsx`). This component only plays them: it asks
 * the shell to move the workspace where a step needs it (`onNavigate`), finds
 * the step's boxes every frame (so a resize, the rail folding or a page still
 * settling never leaves the light behind), and morphs one cut-out between them.
 *
 * The light is a single element whose box-shadow is the mask, so moving between
 * targets is a CSS transition of its box: no canvas, no SVG path rebuilt per
 * frame, and `prefers-reduced-motion` turns it into a cut.
 *
 * It is a modal while it plays: the rest of the page takes no pointer, focus
 * stays in the card (Tab cycles, ←/→ step, Esc skips) and goes back where it was
 * when the tour ends. Another modal dialog outranks it: while one is open (the
 * access-code gate, a confirmation) the tour steps aside, hidden and holding no
 * pointer, focus or key, and comes back where it was once that dialog closes.
 */

import { ArrowRight, Play, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils/cn';
import { setTourActive } from '@/lib/workbench/onboarding';
import { TOUR_EXAMPLES, type TourStep, type TourTarget, type TourView } from './tour-steps';
import { placeTourCard } from './tour-placement';

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** How the tour ended, which decides where the shell leaves the workspace. */
export type TourEnd = 'skip' | 'done' | 'guide' | 'example';

const PAD = 8;
/** Frames a target must hold still before the light moves to it. */
const SETTLE_FRAMES = 8;
/** How long the light may hold before it says it is waiting. */
const WAIT_SHOW_MS = 180;
/** How long a step waits for its area before it is told without one. */
const GIVE_UP_MS = 2500;
const EXIT_MS = 220;

function unionOf(group: readonly TourTarget[]): Rect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const target of group) {
    const selector = typeof target === 'string' ? target : target.selector;
    const max = typeof target === 'string' ? Infinity : target.max;
    let taken = 0;
    for (const element of document.querySelectorAll(selector)) {
      if (taken >= max) break;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      taken += 1;
      left = Math.min(left, box.left);
      top = Math.min(top, box.top);
      right = Math.max(right, box.right);
      bottom = Math.max(bottom, box.bottom);
    }
  }
  if (left === Infinity) return null;
  return { x: left - PAD, y: top - PAD, w: right - left + PAD * 2, h: bottom - top + PAD * 2 };
}

function measure(target: TourStep['target'] | string): Rect | null {
  if (target === null) return null;
  if (typeof target === 'string') return unionOf([target]);
  for (const group of target) {
    const rect = unionOf(group);
    if (rect) return rect;
  }
  return null;
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

/** A modal dialog the tour gives way to: anything but a tour's own card. */
const OTHER_MODAL = [
  '[aria-modal="true"]',
  '[role="alertdialog"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
].join(',');

function otherModalOpen(): boolean {
  for (const element of document.querySelectorAll(OTHER_MODAL)) {
    if (!element.closest('.ws-tour')) return true;
  }
  return false;
}

const WIDE = '(min-width: 768px)';

/** Wide enough for the tour: the rail it points at only exists from `md` up. */
export function useTourViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export function WorkspaceTour({
  steps,
  onNavigate,
  onEnd,
  onSendExample,
  doneLabel = 'workspace.tour.done',
  onStart,
}: {
  readonly steps: readonly TourStep[];
  /** Put the workspace where a step needs it. */
  readonly onNavigate: (view: TourView) => void;
  /** The tour is over (the shell tidies up and marks it seen). */
  readonly onEnd: (how: TourEnd) => void;
  readonly onSendExample: (prompt: string) => void;
  /** The last step's button. */
  readonly doneLabel?: string;
  /** The tour is on screen (the host keeps it up while it moves the workspace). */
  readonly onStart?: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const bodyId = useId();
  const [index, setIndex] = useState(0);
  /** The settled box of this step's target; `null` centres the card. */
  const [rect, setRect] = useState<Rect | null>(null);
  /** The target is not on screen, or not still, for longer than a beat. */
  const [waiting, setWaiting] = useState(false);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [cardH, setCardH] = useState(200);
  const [leaving, setLeaving] = useState(false);
  /** Another modal dialog is open: the tour is hidden and holds nothing. */
  const [yielded, setYielded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const callbacks = useRef({ onNavigate, onEnd, onSendExample, onStart });
  useEffect(() => {
    callbacks.current = { onNavigate, onEnd, onSendExample, onStart };
  });

  const step = steps[index];
  const last = index === steps.length - 1;

  // Playing: hints that would open under the tour wait; focus comes back after.
  useLayoutEffect(() => {
    callbacks.current.onStart?.();
    setTourActive(true);
    returnFocus.current = document.activeElement;
    return () => setTourActive(false);
  }, []);

  /*
   * Where the workspace is. It moves only when the user moves the tour: Next
   * or Back to a step that needs another view, or a click on a lit element
   * that navigates by itself. Never on a timer, never on its own.
   */
  const view = useRef<TourView>(steps[0]?.view ?? 'home');
  const viewOf = useCallback(
    (at: number): TourView => {
      for (let i = at; i >= 0; i -= 1) {
        const v = steps[i]?.view;
        if (v) return v;
      }
      return 'home';
    },
    [steps],
  );

  /*
   * Follow the target every frame, and move the light only to a box that has
   * held still for a few frames: a view still changing, a course still
   * loading or a list still laying out never gets pointed at mid-move. While
   * there is nothing still to point at, the light holds where it was and,
   * after a beat, says it is waiting.
   */
  const settled = useRef<{ step: string; rect: Rect | null } | null>(null);
  useEffect(() => {
    let frame = 0;
    let candidate: Rect | null = null;
    let still = 0;
    let waitingSince = performance.now();
    const stepStarted = waitingSince;
    const tick = () => {
      const now = performance.now();
      setYielded(otherModalOpen());
      if (step.target === null) {
        if (settled.current?.step !== step.id) {
          settled.current = { step: step.id, rect: null };
          setRect(null);
        }
        setWaiting(false);
      } else {
        const next = measure(step.target);
        if (next && candidate && sameRect(next, candidate)) still += 1;
        else still = 0;
        candidate = next;
        if (next && still >= SETTLE_FRAMES) {
          if (settled.current?.step !== step.id || !sameRect(next, settled.current.rect)) {
            settled.current = { step: step.id, rect: next };
            setRect(next);
          }
          waitingSince = now;
          setWaiting(false);
        } else if (settled.current?.step !== step.id) {
          if (!next && now - stepStarted > GIVE_UP_MS) {
            // The area is not on this screen (a layout without it): say the
            // step in the middle rather than hold the tour up.
            settled.current = { step: step.id, rect: null };
            setRect(null);
            setWaiting(false);
          } else {
            setWaiting(now - waitingSince > WAIT_SHOW_MS);
          }
        }
      }
      setViewport((current) =>
        current.w === window.innerWidth && current.h === window.innerHeight
          ? current
          : { w: window.innerWidth, h: window.innerHeight },
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step]);

  /*
   * The card's height, which decides where it fits. Observed through the ref
   * itself rather than once on mount: the card is a new element whenever the
   * tour moves into its portal host (the host may not exist yet on the very
   * first render), and an observer left on the detached first card would
   * report 0 and let the card hang off the bottom of the window.
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  const setCard = useCallback((card: HTMLDivElement | null) => {
    cardRef.current = card;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!card) return;
    setCardH(card.offsetHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (card.isConnected) setCardH(card.offsetHeight);
    });
    observer.observe(card);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  // A new step's content is laid out before it is placed, not a frame after.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card?.isConnected) setCardH(card.offsetHeight);
  }, [index]);

  const end = useCallback(
    (how: TourEnd, then?: () => void) => {
      if (leaving) return;
      setLeaving(true);
      window.setTimeout(() => {
        callbacks.current.onEnd(how);
        then?.();
        if (how === 'guide' || how === 'example') return;
        // Back where focus was, or (it was nowhere in particular, as on a first
        // load) in the composer the tour ends on.
        window.requestAnimationFrame(() => {
          const back = returnFocus.current;
          const target =
            back instanceof HTMLElement && back.isConnected && back !== document.body
              ? back
              : document.querySelector<HTMLElement>('[data-testid="pro-launch-prompt"]');
          target?.focus();
        });
      }, EXIT_MS);
    },
    [leaving],
  );

  /** Move to another step; `navigated` means the app already moved itself. */
  const goTo = useCallback(
    (next: number, navigated = false) => {
      if (next < 0) return;
      if (next >= steps.length) return end('done');
      const needed = viewOf(next);
      if (needed !== view.current) {
        view.current = needed;
        if (!navigated) callbacks.current.onNavigate(needed);
      }
      setIndex(next);
    },
    [end, steps.length, viewOf],
  );
  const go = useCallback((delta: number) => goTo(index + delta), [goTo, index]);

  // A lit element that takes clicks: its own click is the way forward (the
  // app navigates as it always does), so the tour just follows.
  useEffect(() => {
    if (!step.passThrough || step.target === null) return;
    if (yielded) return;
    const onClick = (event: MouseEvent) => {
      const hit = (event.target as Element | null)?.closest?.(
        step
          .target!.flat()
          .map((t) => (typeof t === 'string' ? t : t.selector))
          .join(','),
      );
      if (hit) goTo(index + 1, true);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [goTo, index, step, yielded]);

  // The card keeps the focus: its main button on each step, and back into the
  // card whenever something else takes it (a menu that closed restoring focus
  // to its trigger, a pane that autofocuses as the tour opens it).
  // Never while another modal dialog is open: its focus is its own.
  useEffect(() => {
    if (yielded) return;
    primaryRef.current?.focus({ preventScroll: true });
  }, [index, yielded]);
  useEffect(() => {
    if (yielded) return;
    const onFocusIn = (event: FocusEvent) => {
      const card = cardRef.current;
      if (!card || leaving || card.contains(event.target as Node)) return;
      if (otherModalOpen()) return;
      primaryRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    // Whatever held focus when the tour opened may keep it past the first
    // effect (a closing menu returns focus a frame later).
    const timer = window.setTimeout(() => {
      const card = cardRef.current;
      if (card?.contains(document.activeElement) || otherModalOpen()) return;
      primaryRef.current?.focus();
    }, 120);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.clearTimeout(timer);
    };
  }, [leaving, yielded]);

  useEffect(() => {
    if (yielded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The keys belong to a dialog opened over the tour (Esc closes it, not
      // the tour), even in the frame before the tour has noticed it.
      if (otherModalOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        end('skip');
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const inField = (event.target as HTMLElement | null)?.closest('input, textarea');
        if (inField) return;
        event.preventDefault();
        go(event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (event.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const focusable = [
        ...card.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex="0"]'),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [end, go, yielded]);

  const vw = viewport.w || (typeof window === 'undefined' ? 1440 : window.innerWidth);
  const vh = viewport.h || (typeof window === 'undefined' ? 900 : window.innerHeight);
  const lit = step.target === null ? null : rect;
  const card = placeTourCard(lit, cardH, vw, vh);
  // A centred step shrinks the light to a point in the middle, so the next
  // step's light opens out of the card rather than out of a corner.
  const hole = lit ?? { x: vw / 2, y: vh / 2, w: 0, h: 0 };
  const radius = lit ? Math.min(18, lit.h / 2) : 0;

  const tour = (
    <div
      className={cn('ws-tour', leaving && 'ws-tour-leaving', yielded && 'ws-tour-yielded')}
      data-testid="workspace-tour"
      data-step={step.id}
      data-yielded={yielded || undefined}
      // Out of the accessibility tree too while a dialog is over it.
      inert={yielded || undefined}
    >
      {/* Takes every pointer, so the page under the mask stays still -- all but
          the lit box, on a step whose lit element takes its own click. */}
      {step.passThrough && lit && !waiting ? (
        <>
          <div className="ws-tour-block" style={{ bottom: vh - lit.y }} aria-hidden="true" />
          <div className="ws-tour-block" style={{ top: lit.y + lit.h }} aria-hidden="true" />
          <div
            className="ws-tour-block"
            style={{ top: lit.y, height: lit.h, right: vw - lit.x }}
            aria-hidden="true"
          />
          <div
            className="ws-tour-block"
            style={{ top: lit.y, height: lit.h, left: lit.x + lit.w }}
            aria-hidden="true"
          />
        </>
      ) : (
        <div className="ws-tour-block" aria-hidden="true" />
      )}
      <div
        className={cn(
          'ws-tour-hole',
          !lit && 'ws-tour-hole-none',
          waiting && 'ws-tour-hole-wait',
          step.passThrough && !waiting && 'ws-tour-hole-live',
        )}
        data-testid="workspace-tour-hole"
        aria-hidden="true"
        style={{
          transform: `translate3d(${hole.x}px, ${hole.y}px, 0)`,
          width: hole.w,
          height: hole.h,
          borderRadius: radius,
        }}
      />
      <div
        ref={setCard}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid="workspace-tour-card"
        data-waiting={waiting || undefined}
        className={cn('ws-tour-card', waiting && 'ws-tour-card-wait')}
        style={{
          transform: `translate3d(${card.x}px, ${card.y}px, 0)`,
          // A window too short for the card: it scrolls inside, on screen.
          maxHeight: card.maxHeight,
        }}
      >
        <div className="ws-tour-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${(index + 1) / steps.length})` }} />
        </div>
        <div key={step.id} className="ws-tour-content">
          <div className="ws-tour-head">
            <span className="ws-tour-badge">{index + 1}</span>
            <h2 id={titleId} className="ws-tour-title">
              {t(`workspace.tour.${step.id}.title`)}
            </h2>
            <button
              type="button"
              data-testid="workspace-tour-close"
              className="ws-tour-close"
              aria-label={t('workspace.tour.skip')}
              title={t('workspace.tour.skip')}
              onClick={() => end('skip')}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <p id={bodyId} className="ws-tour-body">
            {t(`workspace.tour.${step.id}.body`)}
          </p>
          {step.lines ? (
            <ul className="ws-tour-lines">
              {step.lines.map(({ icon: Icon, key }) => (
                <li key={key}>
                  <Icon className="size-3.5" aria-hidden="true" />
                  <span>{t(key)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {step.action === 'examples' ? (
            <div className="ws-tour-examples">
              {TOUR_EXAMPLES.map((id, i) => (
                <button
                  key={id}
                  ref={i === 0 ? primaryRef : undefined}
                  type="button"
                  data-testid={`workspace-tour-example-${id}`}
                  className="ws-tour-example"
                  style={{ animationDelay: `${80 + i * 55}ms` }}
                  onClick={() => {
                    const prompt = t(`workspace.tour.examples.${id}.prompt`);
                    end('example', () => callbacks.current.onSendExample(prompt));
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t(`workspace.tour.examples.${id}.label`)}
                  </span>
                  <ArrowRight className="size-3.5 shrink-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="ws-tour-foot">
          <span className="ws-tour-count" aria-live="polite">
            {t('workspace.tour.count', { index: index + 1, total: steps.length })}
          </span>
          <span className="flex-1" />
          {index > 0 ? (
            <button
              type="button"
              data-testid="workspace-tour-prev"
              className="ws-tour-btn"
              onClick={() => go(-1)}
            >
              {t('workspace.tour.prev')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="workspace-tour-skip"
              className="ws-tour-btn"
              onClick={() => end('skip')}
            >
              {t('workspace.tour.skip')}
            </button>
          )}
          {step.action === 'openGuide' ? (
            <button
              type="button"
              data-testid="workspace-tour-open-guide"
              className="ws-tour-btn"
              onClick={() => end('guide')}
            >
              {t('workspace.tour.openGuide')}
            </button>
          ) : null}
          {last ? (
            <button
              type="button"
              data-testid="workspace-tour-done"
              className="ws-tour-btn ws-tour-btn-primary"
              onClick={() => end('done')}
            >
              {t(doneLabel)}
            </button>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              data-testid="workspace-tour-next"
              className="ws-tour-btn ws-tour-btn-primary"
              onClick={() => go(1)}
            >
              {step.action === 'openGuide' ? (
                <Play className="size-3 fill-current" aria-hidden="true" />
              ) : null}
              {t(step.nextLabel ?? 'workspace.tour.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
  // Rendered at the shell's root: its tokens live there, and no pane's
  // entrance transform can become the fixed layer's containing block.
  const host = typeof document === 'undefined' ? null : document.querySelector('.ws-root');
  return host ? createPortal(tour, host) : tour;
}
