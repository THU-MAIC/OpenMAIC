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
 * pulling the edge inward past the threshold folds the pane mid-drag, the same
 * drag carried back out unfolds it, and a folded pane's own edge (`folded`)
 * starts the same gesture from the other side. The gesture itself (thresholds,
 * hysteresis, window-level tracking that survives this handle unmounting) is
 * `trackFoldableResize`, shared with the classroom dock's top edge.
 *
 * A drag still in flight is aborted as its owner unmounts. By default the owner
 * is this handle. A handle that may be swapped for another mid-drag (the rail's
 * open and folded edges) is given an owner that outlives the swap
 * (`useResizeDragOwner`, held by the shell), so the drag carries on.
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
import { trackFoldableResize } from '@/lib/utils/foldable-resize';

import { useResizeDragOwner, type ResizeDragOwner } from './resize-drag-owner';

export { RESIZE_FOLD_HYSTERESIS } from '@/lib/utils/foldable-resize';

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
  drag,
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
  /**
   * Who aborts a drag still in flight as it unmounts. Defaults to this handle;
   * pass one that outlives the handle when the handle may unmount mid-drag.
   */
  readonly drag?: ResizeDragOwner;
}) {
  const ownDrag = useResizeDragOwner();
  const owner = drag ?? ownDrag;
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
    const remembered = current();
    handle.setAttribute('data-ws-drag', 'true');
    document.documentElement.setAttribute('data-ws-resizing', 'true');
    owner.abort();
    const abort = trackFoldableResize({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      axis: 'x',
      grow: edge === 'right' ? 1 : -1,
      // A folded pane's edge starts from the folded pane's own width.
      startSize: folded ? (handle.parentElement?.getBoundingClientRect().width ?? 0) : remembered,
      remembered,
      folded,
      collapseBelow,
      handlers: () => props.current,
      onEnd: () => {
        owner.release(abort);
        handle.removeAttribute('data-ws-drag');
        document.documentElement.removeAttribute('data-ws-resizing');
      },
    });
    owner.hold(abort);
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
