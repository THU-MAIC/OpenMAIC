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
 * A seam may still opt into drag-to-collapse (`collapseBelow` + `onCollapse`),
 * the way editors and sidebars commonly behave: pulling the edge well past the
 * pane's minimum width folds it on release. This is the same drag gesture
 * carried further, not a second control on the seam. While the pointer is past
 * the threshold the width holds at its minimum and `data-ws-collapse-armed`
 * marks the handle, so the pane can show that letting go will fold it; moving
 * back out disarms it. The fold happens on release rather than live because
 * the folded pane has no seam of its own: folding mid-drag would unmount this
 * handle under the captured pointer. On a fold, the width is put back to what
 * it was before the drag, so unfolding opens the pane at its remembered width.
 *
 * The active state is keyed off `data-ws-drag` ON THIS HANDLE rather than the
 * document flag: `data-ws-resizing` is shared by every seam on the page, and
 * lighting all of them while one is moving misreports what is happening.
 *
 * The pointer is CAPTURED, so a fast drag that outruns the cursor still
 * tracks; `data-ws-resizing` on the document element is what stops the cursor
 * flickering and text selecting as the pointer travels over other elements.
 */

import { useRef } from 'react';
import { cn } from '@/lib/utils/cn';

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
}: {
  readonly testId: string;
  readonly label: string;
  /** Which edge of the pane the strip sits on. */
  readonly edge: 'left' | 'right';
  readonly current: () => number;
  readonly clamp: (width: number) => number;
  readonly onPreview: (width: number) => void;
  readonly onCommit: (width: number) => void;
  readonly onReset: () => void;
  /**
   * Opt-in drag-to-collapse: an unclamped width below this many pixels arms a
   * fold, and releasing while armed calls `onCollapse` instead of `onCommit`.
   */
  readonly collapseBelow?: number;
  readonly onCollapse?: () => void;
}) {
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startWidth: number;
    latest: number;
    moved: boolean;
    armed: boolean;
  } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons: a right-click drag is not a resize.
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.setAttribute('data-ws-drag', 'true');
    const start = current();
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startWidth: start,
      latest: start,
      moved: false,
      armed: false,
    };
    document.documentElement.setAttribute('data-ws-resizing', 'true');
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) {
      drag.moved = true;
    }
    const delta = edge === 'right' ? event.clientX - drag.startX : drag.startX - event.clientX;
    const raw = drag.startWidth + delta;
    drag.latest = clamp(raw);
    const armed = collapseBelow !== undefined && onCollapse !== undefined && raw < collapseBelow;
    if (armed !== drag.armed) {
      drag.armed = armed;
      if (armed) event.currentTarget.setAttribute('data-ws-collapse-armed', 'true');
      else event.currentTarget.removeAttribute('data-ws-collapse-armed');
    }
    onPreview(drag.latest);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    event.currentTarget.removeAttribute('data-ws-drag');
    event.currentTarget.removeAttribute('data-ws-collapse-armed');
    document.documentElement.removeAttribute('data-ws-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.armed) {
      // Put back the width the pane had before the drag (nothing was persisted
      // mid-drag), so unfolding it later does not open it at the minimum.
      onPreview(drag.startWidth);
      // A cancelled pointer (the OS took it) is not the user letting go.
      if (event.type !== 'pointercancel') onCollapse?.();
      return;
    }
    // A press that never moved is not a resize, and it is not a fold either.
    if (drag.moved) onCommit(drag.latest);
  };

  return (
    <div
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
