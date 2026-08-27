'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CLASSROOM_ASPECT_RATIO, containBox, fillWidthBox } from '@/lib/edit/contain-box';
import { cn } from '@/lib/utils';

/**
 * 16:9 stage box.
 * `contain` — largest box that fits (letterbox).
 * `fill-width` — as wide as the host; extra height is clipped. Dragging the
 * workbench bar then grows the canvas instead of a white strip.
 */

/** CSS properties whose transition end can settle the host's size. */
const LAYOUT_PROPERTIES = new Set([
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'flex',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
]);

export function ContainBox({
  ratio = CLASSROOM_ASPECT_RATIO,
  fit = 'contain',
  className,
  children,
}: {
  readonly ratio?: number;
  readonly fit?: 'contain' | 'fill-width';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    // Publish only when the box actually changed. The rAF settle re-measures
    // and the transition/animation listeners can report a size that already
    // rendered, and an unconditional setBox on every ResizeObserver delivery
    // would re-render for identical boxes — with the extra re-measure passes
    // below that churn would also run for every settle, not just real changes.
    const apply = (next: { readonly width: number; readonly height: number }) => {
      setBox((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };

    const measure = () => {
      apply(
        fit === 'fill-width'
          ? fillWidthBox(el.clientWidth, ratio)
          : containBox(el.clientWidth, el.clientHeight, ratio),
      );
    };

    // First-paint measurement. When a course opens, the classroom pane mounts
    // while the workbench is still settling (the chat pane re-flows from fill
    // to fixed width, the pane's own column lands a frame or two later, the
    // scene rail can mount async once its list loads, fonts shift content) —
    // so the host box read here can be a stale full-width, or zero while the
    // pane is hidden. Any ONE of those can land later than a couple of rAFs,
    // which is what left first-open canvases mis-sized until a seam drag
    // re-measured. Instead of betting on the right instant, measure every
    // frame for a bounded settle window after mount; `apply` publishes only on
    // change, so identical reads are free and there is no render churn.
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The frame is the host's sizing ancestor; watching it too catches a
    // squeeze that lands on the frame one frame before the host's own box
    // updates (rail width hydration, grid track redistribution).
    if (el.parentElement) ro.observe(el.parentElement);
    // Backstop: a layout settlement has been observed in the wild that left
    // the host at a stale size with no further RO delivery (first-open with
    // the slide rail expanded stayed mis-sized until a seam drag). Re-measure
    // on a slow interval for the lifetime of the mount; `apply` publishes only
    // on change, so a stable layout costs one cheap clientWidth read per tick.
    const backstop = window.setInterval(measure, 400);
    let settleRaf = 0;
    let settleUntil = 0;
    const SETTLE_WINDOW_MS = 1500;
    const loop = () => {
      measure();
      settleRaf = performance.now() < settleUntil ? requestAnimationFrame(loop) : 0;
    };
    const kick = (ms: number) => {
      settleUntil = performance.now() + ms;
      if (!settleRaf) settleRaf = requestAnimationFrame(loop);
    };
    kick(SETTLE_WINDOW_MS);

    // The pane can also settle through a width transition or animation that
    // the ResizeObserver only tracks frame by frame (the scene rail's 0.3s
    // width transition, a pane column animating in). The transition/animation
    // END is the authoritative "settled" signal — restart a short settle
    // window on it. Listened on the document in capture phase because the
    // transitioning element is usually an ancestor or sibling of the host
    // (rail, chat pane, pane column) — a listener on the host subtree would
    // never see those. `transitionend` is filtered to layout-affecting
    // properties; `animationend` fires once by definition.
    const onSettled = (event: Event) => {
      if (event.type === 'transitionend') {
        const { propertyName } = event as TransitionEvent;
        if (propertyName && !LAYOUT_PROPERTIES.has(propertyName)) return;
      }
      kick(400);
    };
    document.addEventListener('transitionend', onSettled, true);
    document.addEventListener('animationend', onSettled, true);

    return () => {
      window.clearInterval(backstop);
      if (settleRaf) cancelAnimationFrame(settleRaf);
      settleRaf = 0;
      document.removeEventListener('transitionend', onSettled, true);
      document.removeEventListener('animationend', onSettled, true);
      ro.disconnect();
    };
  }, [fit, ratio]);

  return (
    <div
      ref={hostRef}
      className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden"
    >
      <div
        className={cn('relative', className)}
        style={
          box.width > 0
            ? { width: box.width, height: box.height }
            : { width: '100%', height: '100%' }
        }
      >
        {children}
      </div>
    </div>
  );
}
