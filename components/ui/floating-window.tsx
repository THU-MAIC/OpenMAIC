'use client';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EDGES = [
  ['n', 'inset-x-3 top-0 h-1.5 cursor-ns-resize'],
  ['s', 'inset-x-3 bottom-0 h-1.5 cursor-ns-resize'],
  ['w', 'inset-y-3 start-0 w-1.5 cursor-ew-resize'],
  ['e', 'inset-y-3 end-0 w-1.5 cursor-ew-resize'],
  ['nw', 'start-0 top-0 size-3 cursor-nwse-resize'],
  ['ne', 'end-0 top-0 size-3 cursor-nesw-resize'],
  ['sw', 'bottom-0 start-0 size-3 cursor-nesw-resize'],
  ['se', 'bottom-0 end-0 size-3 cursor-nwse-resize'],
] as const;

function clamp(rect: WindowRect, bounds: { width: number; height: number }, min: WindowRect) {
  const width = Math.min(Math.max(rect.width, min.width), Math.max(bounds.width, min.width));
  const height = Math.min(Math.max(rect.height, min.height), Math.max(bounds.height, min.height));
  return {
    width,
    height,
    x: Math.min(Math.max(rect.x, 0), Math.max(bounds.width - width, 0)),
    y: Math.min(Math.max(rect.y, 0), Math.max(bounds.height - height, 0)),
  };
}

/**
 * A window inside the workbench: dragged by any `[data-window-drag]` region, resized from
 * its edges, and kept within its positioned parent.
 */
export function FloatingWindow({
  initial,
  minWidth = 320,
  minHeight = 220,
  className,
  children,
  testId,
}: {
  initial: (bounds: { width: number; height: number }) => WindowRect;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<WindowRect | null>(null);
  const min = { x: 0, y: 0, width: minWidth, height: minHeight };
  const bounds = () => {
    const parent = root.current?.offsetParent as HTMLElement | null;
    return { width: parent?.clientWidth ?? 0, height: parent?.clientHeight ?? 0 };
  };
  // The first placement waits for the parent to have a size and is taken once; later moves
  // belong to the learner.
  const place = () =>
    setRect((current) => {
      const limit = bounds();
      if (!limit.width || !limit.height) return current;
      return clamp(current ?? initial(limit), limit, min);
    });
  useLayoutEffect(() => {
    place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const parent = root.current?.offsetParent;
    if (!parent) return;
    const observer = new ResizeObserver(place);
    observer.observe(parent);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const track = (
    event: React.PointerEvent,
    apply: (start: WindowRect, dx: number, dy: number) => WindowRect,
  ) => {
    if (!rect || event.button !== 0) return;
    event.preventDefault();
    const start = rect,
      x0 = event.clientX,
      y0 = event.clientY,
      limit = bounds();
    const move = (e: PointerEvent) =>
      setRect(clamp(apply(start, e.clientX - x0, e.clientY - y0), limit, min));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };
  return (
    <div
      ref={root}
      data-testid={testId}
      className={cn('pointer-events-auto absolute flex flex-col', className, !rect && 'invisible')}
      style={
        rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined
      }
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest('[data-window-drag]') || target.closest('button,a,input,textarea'))
          return;
        track(event, (start, dx, dy) => ({ ...start, x: start.x + dx, y: start.y + dy }));
      }}
    >
      {children}
      {EDGES.map(([edge, position]) => (
        <div
          key={edge}
          aria-hidden="true"
          data-window-resize={edge}
          className={cn('absolute z-10 touch-none', position)}
          onPointerDown={(event) => {
            event.stopPropagation();
            track(event, (start, dx, dy) => {
              const next = { ...start };
              if (edge.includes('e')) next.width = Math.max(start.width + dx, minWidth);
              if (edge.includes('s')) next.height = Math.max(start.height + dy, minHeight);
              if (edge.includes('w')) {
                next.width = Math.max(start.width - dx, minWidth);
                next.x = start.x + start.width - next.width;
              }
              if (edge.includes('n')) {
                next.height = Math.max(start.height - dy, minHeight);
                next.y = start.y + start.height - next.height;
              }
              return next;
            });
          }}
        />
      ))}
    </div>
  );
}
