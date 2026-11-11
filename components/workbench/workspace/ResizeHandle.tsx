'use client';

/**
 * The seam between two panes: a resize control, and only that.
 *
 * A 6px grab strip straddling a pane's edge. Hover strengthens its hairline;
 * dragging moves the seam, double-clicking the rule resets the width.
 *
 * It carries NO fold button any more. A seam sits between two collapsible panes,
 * so a fold on it can only ever speak for one of them — and when both got one,
 * the seam's midpoint grew two mutually-reversed chevrons two centimetres from a
 * third (the slide navigator's own fold, at the classroom's left edge). Three
 * chevrons at one height, none of which says which panel it means, is a puzzle.
 * Folding a pane now lives in that pane's own header (`PaneFoldButton`), where
 * there is exactly one of them and it is attached to the thing it folds.
 *
 * The navigation rail was the last exception and is not one any more: it folds
 * from its own header row (the wordmark and the PRO pill) like the other two, so
 * this handle no longer looks for a collapse grip beside it and a press released
 * without moving does nothing. Every seam on the surface now means exactly one
 * thing.
 *
 * A seam may opt into drag-to-collapse (`collapseBelow` + `onCollapse` +
 * `onExpand`), the way editors commonly behave, live and within one gesture:
 * pulling the edge inward until the unclamped width passes `collapseBelow`
 * folds the pane at once, mid-drag; carrying the same drag back outward past
 * the threshold (plus a small hysteresis, so the boundary does not flicker)
 * unfolds it and the edge follows the pointer again. A folded pane's own edge
 * (`folded`) starts the same gesture from the other side. The remembered
 * width is never touched by a fold: folding puts back the width the pane had
 * before the drag. A cancelled pointer leaves things as they are.
 *
 * Because folding swaps the pane (and this handle with it) mid-drag, the drag
 * is tracked on the window from pointerdown on, not on the handle: the handle
 * may unmount under the pointer and the gesture carries on.
 *
 * The active state is keyed off `data-ws-drag` ON THIS HANDLE rather than the
 * document flag: `data-ws-resizing` is shared by every seam on the page, and
 * lighting all of them while one is moving misreports what is happening.
 *
 * `data-ws-resizing` on the document element is what stops the cursor
 * flickering and text selecting as the pointer travels over other elements.
 */

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';

/** How far past the collapse threshold a folded drag must come back to unfold. */
export const RESIZE_FOLD_HYSTERESIS = 8;

export function ResizeHandle({
  testId,
  label,
  edge,
  current,
  clamp,
  onPreview,
  onCommit,
  onReset,
  collapseBelow,
  onCollapse,
  onExpand,
  folded = false,
}: {
  readonly testId: string;
  readonly label: string;
  /** Which edge of the pane the strip sits on. */
  readonly edge: 'left' | 'right';
  /** The pane's (remembered) width. */
  readonly current: () => number;
  readonly clamp: (width: number) => number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
  readonly onReset: () => void;
  /**
   * Opt-in drag-to-collapse: an unclamped width below this many pixels folds
   * the pane mid-drag (`onCollapse`); coming back past it unfolds (`onExpand`).
   */
  readonly collapseBelow?: number;
  readonly onCollapse?: () => void;
  readonly onExpand?: () => void;
  /** This is the folded pane's edge: the gesture starts folded. */
  readonly folded?: boolean;
}) {
  // The latest callbacks, read by the window listeners of a drag that may
  // outlive this render (and this handle).
  const props = useRef({ clamp, onPreview, onCommit, onCollapse, onExpand });
  useEffect(() => {
    props.current = { clamp, onPreview, onCommit, onCollapse, onExpand };
  });

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons: a right-click drag is not a resize.
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const canFold =
      collapseBelow !== undefined && onCollapse !== undefined && onExpand !== undefined;
    const remembered = current();
    // A folded pane's edge starts from the folded pane's own width.
    const startWidth = folded
      ? (handle.parentElement?.getBoundingClientRect().width ?? 0)
      : remembered;
    const drag = {
      startX: event.clientX,
      startY: event.clientY,
      latest: remembered,
      moved: false,
      isFolded: folded,
      startedFolded: folded,
    };
    handle.setAttribute('data-ws-drag', 'true');
    document.documentElement.setAttribute('data-ws-resizing', 'true');

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= 3) drag.moved = true;
      const delta = edge === 'right' ? e.clientX - drag.startX : drag.startX - e.clientX;
      const raw = startWidth + delta;
      const p = props.current;
      if (canFold && collapseBelow !== undefined) {
        if (!drag.isFolded && raw < collapseBelow) {
          drag.isFolded = true;
          // The remembered width stays what it was before the drag.
          p.onPreview(remembered);
          drag.latest = remembered;
          p.onCollapse?.();
          return;
        }
        if (drag.isFolded && raw >= collapseBelow + RESIZE_FOLD_HYSTERESIS) {
          drag.isFolded = false;
          p.onExpand?.();
        }
        if (drag.isFolded) return;
      }
      drag.latest = p.clamp(raw);
      p.onPreview(drag.latest);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      handle.removeAttribute('data-ws-drag');
      document.documentElement.removeAttribute('data-ws-resizing');
      // Open at the end of a drag that moved: the width it reached is the new
      // one (a cancelled pointer keeps it too). Folded: nothing to commit.
      if (!drag.isFolded && drag.moved) props.current.onCommit(drag.latest);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      className={cn(
        'ws-resize absolute inset-y-0 z-20 w-1.5 cursor-col-resize',
        edge === 'right' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2',
      )}
    >
      <span className="ws-resize-thread" aria-hidden="true" />
    </div>
  );
}
