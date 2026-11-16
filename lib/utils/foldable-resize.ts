/**
 * The resize gesture shared by every edge that can also fold its pane by being
 * dragged past a threshold: the workspace rail (horizontal) and the classroom
 * dock (vertical).
 *
 * Within one drag, live: pulling the edge inward until the unclamped size
 * passes `collapseBelow` folds the pane at once, mid-drag; carrying the same
 * drag back outward past the threshold plus a small hysteresis unfolds it, and
 * the edge follows the pointer again. A drag may also start folded (from the
 * folded pane's own edge). The remembered size is never touched by a fold. A
 * press released without moving changes nothing, and a cancelled pointer
 * leaves things as they are.
 *
 * The drag is tracked on the window from pointerdown on, not on the handle:
 * folding may swap the pane (and its handle) under the pointer, and the
 * gesture has to carry on.
 */

/** How far past the collapse threshold a folded drag must come back to unfold. */
export const RESIZE_FOLD_HYSTERESIS = 8;

/** How far the pointer must travel before a press counts as a drag. */
const DRAG_SLOP = 3;

/**
 * Whether the pane is folded once the unclamped size reaches `raw`, given
 * whether it is folded now. The band between the threshold and the threshold
 * plus the hysteresis keeps whatever state the pane is in, so a pointer
 * hovering at the boundary does not flicker it.
 */
export function nextFolded(
  folded: boolean,
  raw: number,
  collapseBelow: number,
  hysteresis: number = RESIZE_FOLD_HYSTERESIS,
): boolean {
  return folded ? raw < collapseBelow + hysteresis : raw < collapseBelow;
}

export interface FoldableResizeHandlers {
  readonly clamp: (size: number) => number;
  /** The size to show now, mid-drag. */
  readonly onPreview: (size: number) => void;
  /** The drag ended open after moving: this is the new remembered size. */
  readonly onCommit: (size: number) => void;
  readonly onCollapse?: () => void;
  readonly onExpand?: () => void;
}

export interface FoldableResizeStart {
  readonly pointerId: number;
  readonly clientX: number;
  readonly clientY: number;
  /** The axis the pane's size lies along. */
  readonly axis: 'x' | 'y';
  /** +1 when moving the pointer along the axis grows the pane, -1 when it shrinks it. */
  readonly grow: 1 | -1;
  /** The pane's size on screen as the drag starts (a folded pane's folded size). */
  readonly startSize: number;
  /** The pane's remembered (open) size. */
  readonly remembered: number;
  /** The drag starts from a folded pane's edge. */
  readonly folded: boolean;
  /** Opt-in drag-to-collapse: an unclamped size below this folds the pane. */
  readonly collapseBelow?: number;
  /** Read on every move: the latest handlers of a drag that may outlive its handle. */
  readonly handlers: () => FoldableResizeHandlers;
  /** Called once, as the drag ends or is aborted. */
  readonly onEnd?: () => void;
}

/**
 * Tracks one drag from its pointerdown to its end; returns a function that
 * aborts it (listeners removed, `onEnd` called, nothing committed). Aborting a
 * drag that has already ended does nothing.
 */
export function trackFoldableResize(start: FoldableResizeStart): () => void {
  const initial = start.handlers();
  const canFold =
    start.collapseBelow !== undefined &&
    initial.onCollapse !== undefined &&
    initial.onExpand !== undefined;
  const drag = {
    latest: start.remembered,
    moved: false,
    folded: start.folded,
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    // Released outside the window: the pointerup never reached us.
    if (e.buttons === 0) {
      finish(true);
      return;
    }
    if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) >= DRAG_SLOP) {
      drag.moved = true;
    }
    const along = start.axis === 'x' ? e.clientX - start.clientX : e.clientY - start.clientY;
    const raw = start.startSize + start.grow * along;
    const h = start.handlers();
    if (canFold && start.collapseBelow !== undefined) {
      const folded = nextFolded(drag.folded, raw, start.collapseBelow);
      if (folded && !drag.folded) {
        drag.folded = true;
        // The remembered size stays what it was before the drag.
        h.onPreview(start.remembered);
        drag.latest = start.remembered;
        h.onCollapse?.();
        return;
      }
      if (!folded && drag.folded) {
        drag.folded = false;
        h.onExpand?.();
      }
      if (drag.folded) return;
    }
    drag.latest = h.clamp(raw);
    h.onPreview(drag.latest);
  };

  let ended = false;
  function finish(commit: boolean) {
    if (ended) return;
    ended = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    window.removeEventListener('blur', lost);
    document.removeEventListener('visibilitychange', hidden);
    start.onEnd?.();
    // Open at the end of a drag that moved: the size it reached is the new one.
    // Folded: nothing to commit.
    if (commit && !drag.folded && drag.moved) start.handlers().onCommit(drag.latest);
  }

  function end(e: PointerEvent) {
    if (e.pointerId !== start.pointerId) return;
    finish(true);
  }
  function lost() {
    finish(true);
  }
  function hidden() {
    if (document.visibilityState === 'hidden') finish(true);
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', lost);
  document.addEventListener('visibilitychange', hidden);
  return () => finish(false);
}
