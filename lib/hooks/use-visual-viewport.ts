'use client';

import { useSyncExternalStore } from 'react';

export interface VisibleViewport {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

const listeners = new Set<() => void>();
let snapshot: VisibleViewport | null = null;
let detach: (() => void) | undefined;
let frame: number | undefined;

function measure() {
  const viewport = window.visualViewport;
  const next: VisibleViewport = viewport
    ? {
        width: viewport.width,
        height: viewport.height,
        offsetTop: viewport.offsetTop,
        offsetLeft: viewport.offsetLeft,
        scale: viewport.scale,
      }
    : {
        width: window.innerWidth,
        height: window.innerHeight,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
      };
  if (
    snapshot &&
    (Object.keys(next) as (keyof VisibleViewport)[]).every((key) => snapshot![key] === next[key])
  )
    return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const viewport = window.visualViewport;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    measure();
    detach = () => {
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      snapshot = null;
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detach?.();
      detach = undefined;
    }
  };
}

/** Visible geometry, not keyboard detection. Null on SSR; use CSS as fallback. */
export function useVisualViewport(): VisibleViewport | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}
