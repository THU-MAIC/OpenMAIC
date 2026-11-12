'use client';

/**
 * The classroom dock's box: one height and one fold, kept in settings and shared by
 * both modes, so switching mode never moves the canvas.
 *
 * Dragging moves the dock alone. It grows over the canvas (its height changes and its
 * top margin takes the difference back), straight on the element and with no render,
 * and the canvas lays out once, when the drag ends. The slide is not resized for every
 * pointer move, the same economy as the panes' width animation.
 *
 * Dragging the top edge down past `DOCK_COLLAPSE_BELOW` folds the dock at once, mid-drag,
 * to the same folded state as its fold button; carrying the same drag back up unfolds it
 * and the edge follows the pointer again, and the folded dock's edge starts the same
 * gesture upward. The gesture is the workspace rail's (`trackFoldableResize`): tracked on
 * the window, with a hysteresis at the threshold, a click that does nothing and a
 * remembered height that a fold never touches. A drag still in flight is aborted as the
 * edge unmounts (it stays mounted across a fold: one edge in both states).
 *
 * From the keyboard, ArrowUp / ArrowDown size the open dock, and ArrowUp on the folded
 * dock's edge unfolds it. While folded the separator's range starts at the folded height,
 * so the value it reports stays inside the range it advertises.
 *
 * `data-dragging` on the dock is set as the pointer goes down and cleared as it comes up,
 * never in between (a fold mid-drag included): it only switches off transitions, and
 * nothing under it may hang an entrance animation on it, or the animation would replay
 * at the end of every drag.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  clampDockHeight,
  dockBubbleVars,
  DOCK_COLLAPSE_BELOW,
  DOCK_FOLDED_HEIGHT,
  DOCK_KEYBOARD_STEP,
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
} from '@/lib/edit/dock-height';
import { useSettingsStore } from '@/lib/store/settings';
import { trackFoldableResize } from '@/lib/utils/foldable-resize';

/** The column the dock sits at the bottom of, in both modes: through its one wrapper. */
const hostOf = (dock: HTMLElement | null) => dock?.parentElement?.parentElement ?? null;

export function useDockBox(dockRef: RefObject<HTMLElement | null>, fold = false) {
  const stored = useSettingsStore((state) => state.dockHeight);
  const collapsed = useSettingsStore((state) => state.dockCollapsed) || fold;
  const [hostHeight, setHostHeight] = useState<number | null>(null);

  useEffect(() => {
    const host = hostOf(dockRef.current);
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (host.clientHeight > 0) setHostHeight(host.clientHeight);
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(host);
    return () => resized.disconnect();
  }, [dockRef]);

  return {
    collapsed,
    /** Folded by the classroom rather than by the user: its edge does not unfold it. */
    held: fold,
    height: collapsed ? DOCK_FOLDED_HEIGHT : clampDockHeight(stored, hostHeight),
  };
}

export function DockResizeHandle({
  dockRef,
  folded = false,
}: {
  dockRef: RefObject<HTMLElement | null>;
  /** The dock is folded: dragging this edge up unfolds it. */
  folded?: boolean;
}) {
  const { t } = useI18n();
  const stored = useSettingsStore((state) => state.dockHeight);
  const setDockHeight = useSettingsStore((state) => state.setDockHeight);
  const setDockCollapsed = useSettingsStore((state) => state.setDockCollapsed);
  const settle = useRef<number | null>(null);
  const abortDrag = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      abortDrag.current?.();
      abortDrag.current = null;
    },
    [],
  );

  // Unmeasured (no layout yet) reads as unknown, like `useDockBox`'s.
  const room = () => hostOf(dockRef.current)?.clientHeight || null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (folded) {
      // Up unfolds, to the remembered height, as the fold button does.
      if (event.key !== 'ArrowUp') return;
      event.preventDefault();
      setDockCollapsed(false);
      return;
    }
    const step =
      event.key === 'ArrowUp'
        ? DOCK_KEYBOARD_STEP
        : event.key === 'ArrowDown'
          ? -DOCK_KEYBOARD_STEP
          : 0;
    if (!step) return;
    event.preventDefault();
    setDockHeight(clampDockHeight(stored + step, room()));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const dock = dockRef.current;
    if (!dock || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (settle.current !== null) cancelAnimationFrame(settle.current);
    settle.current = null;
    const remembered = clampDockHeight(useSettingsStore.getState().dockHeight, room());
    // The height the canvas is laid out against: the dock grows over it from there
    // (its top margin takes the difference back) until the drag ends or folds.
    let base = dock.getBoundingClientRect().height;
    dock.dataset.dragging = 'true';
    const settings = useSettingsStore.getState();
    abortDrag.current?.();
    const abort = trackFoldableResize({
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      axis: 'y',
      grow: -1,
      startSize: base,
      remembered,
      folded,
      collapseBelow: DOCK_COLLAPSE_BELOW,
      handlers: () => ({
        clamp: (height) => clampDockHeight(height, room()),
        onPreview: (height) => {
          dock.style.height = `${height}px`;
          dock.style.marginTop = `${base - height}px`;
          // What is inside the dock follows the drag; only the canvas waits for the end.
          for (const [name, value] of Object.entries(dockBubbleVars(height))) {
            dock.style.setProperty(name, value);
          }
        },
        onCommit: (height) => settings.setDockHeight(height),
        // Synchronous, so the dock's own render lands before the next preview does.
        onCollapse: () => {
          dock.style.marginTop = '';
          flushSync(() => settings.setDockCollapsed(true));
        },
        onExpand: () => {
          flushSync(() => settings.setDockCollapsed(false));
          base = dock.getBoundingClientRect().height;
        },
      }),
      onEnd: () => {
        if (abortDrag.current === abort) abortDrag.current = null;
        dock.style.marginTop = '';
        // The commit must not animate: the dock is already there.
        settle.current = requestAnimationFrame(() => {
          settle.current = null;
          delete dock.dataset.dragging;
        });
      },
    });
    abortDrag.current = abort;
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t('stage.dock.resize')}
      aria-valuenow={folded ? DOCK_FOLDED_HEIGHT : stored}
      aria-valuemin={folded ? DOCK_FOLDED_HEIGHT : DOCK_MIN_HEIGHT}
      aria-valuemax={DOCK_MAX_HEIGHT}
      data-testid="dock-resize"
      data-folded={folded ? 'true' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      className="group/handle absolute inset-x-0 -top-px z-30 flex h-2 cursor-row-resize touch-none justify-center outline-none"
    >
      <span className="h-0.5 w-full bg-primary/40 opacity-0 transition-opacity duration-150 group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-active/handle:opacity-100" />
    </div>
  );
}
