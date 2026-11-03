'use client';

/**
 * The classroom dock's box: one height and one fold, kept in settings and shared by
 * both modes, so switching mode never moves the canvas.
 *
 * Dragging moves the dock alone. It grows over the canvas (its height changes and its
 * top margin takes the difference back), straight on the element and with no render,
 * and the canvas lays out once, when the drag ends. The slide is not resized for every
 * pointer move, the same economy as the panes' width animation.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  clampDockHeight,
  DOCK_FOLDED_HEIGHT,
  DOCK_KEYBOARD_STEP,
  DOCK_MAX_HEIGHT,
  DOCK_MIN_HEIGHT,
} from '@/lib/edit/dock-height';
import { useSettingsStore } from '@/lib/store/settings';

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
    height: collapsed ? DOCK_FOLDED_HEIGHT : clampDockHeight(stored, hostHeight),
  };
}

export function DockResizeHandle({ dockRef }: { dockRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const stored = useSettingsStore((state) => state.dockHeight);
  const setDockHeight = useSettingsStore((state) => state.setDockHeight);
  const drag = useRef<{ startY: number; startHeight: number; height: number } | null>(null);

  const room = () => hostOf(dockRef.current)?.clientHeight ?? null;

  const onKeyDown = (event: KeyboardEvent) => {
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

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label={t('stage.dock.resize')}
      aria-valuenow={stored}
      aria-valuemin={DOCK_MIN_HEIGHT}
      aria-valuemax={DOCK_MAX_HEIGHT}
      data-testid="dock-resize"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        const dock = dockRef.current;
        if (!dock) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const startHeight = dock.getBoundingClientRect().height;
        drag.current = { startY: event.clientY, startHeight, height: startHeight };
        dock.dataset.dragging = 'true';
      }}
      onPointerMove={(event) => {
        const dock = dockRef.current;
        const current = drag.current;
        if (!dock || !current) return;
        const height = clampDockHeight(
          current.startHeight + current.startY - event.clientY,
          room(),
        );
        current.height = height;
        dock.style.height = `${height}px`;
        dock.style.marginTop = `${current.startHeight - height}px`;
      }}
      onPointerUp={() => {
        const dock = dockRef.current;
        const current = drag.current;
        drag.current = null;
        if (!dock || !current) return;
        dock.style.marginTop = '';
        setDockHeight(current.height);
        // The commit must not animate: the dock is already there.
        requestAnimationFrame(() => {
          delete dock.dataset.dragging;
        });
      }}
      className="group/handle absolute inset-x-0 -top-px z-30 flex h-2 cursor-row-resize touch-none justify-center outline-none"
    >
      <span className="h-0.5 w-full bg-primary/40 opacity-0 transition-opacity duration-150 group-hover/handle:opacity-100 group-focus-visible/handle:opacity-100 group-active/handle:opacity-100" />
    </div>
  );
}
