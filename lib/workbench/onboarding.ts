'use client';

/**
 * First-run guidance state: which one-time hints this browser has already
 * seen. Local to the browser, like the workspace's tabs and pane folds; there
 * is nothing about it worth an account round trip.
 *
 * The marks:
 * - `home`: the first-run tour (`WorkspaceTour`). Finishing or skipping it sets
 *   the mark; the account menu's "Getting started" clears it and plays it again.
 * - `pane`: the hint the first time a course opens in the classroom pane
 *   (Learn vs Edit, and asking in the chat to change it).
 * - `edit`: the Edit tour, the first time the viewer edits a course of theirs;
 *   the account menu's "Editing guide" clears it.
 */

import { useSyncExternalStore } from 'react';

export type OnboardingMark = 'home' | 'pane' | 'edit';

const KEY = 'openmaic:workspace:onboarding';
const CHANGED = 'openmaic:onboarding-changed';

type Marks = Partial<Record<OnboardingMark, number>>;

function read(): Marks {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Marks) : {};
  } catch {
    return {};
  }
}

function write(marks: Marks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(marks));
  } catch {
    // Storage denied: the hint shows again next visit, which is harmless.
  }
  window.dispatchEvent(new Event(CHANGED));
}

export function markOnboardingSeen(mark: OnboardingMark): void {
  const marks = read();
  if (marks[mark]) return;
  write({ ...marks, [mark]: Date.now() });
}

/** Show the guidance again, as on a first visit. */
export function resetOnboarding(mark?: OnboardingMark): void {
  if (!mark) {
    write({});
    return;
  }
  const { [mark]: _removed, ...rest } = read();
  write(rest);
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) onChange();
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * Whether a mark is still unseen. On the server, and in the first client
 * render, it reads as seen, so the guidance only ever appears after hydration
 * and never flashes for a returning visitor.
 */
export function useOnboardingPending(mark: OnboardingMark): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !read()[mark],
    () => false,
  );
}

/*
 * Whether the tour is playing right now. In memory only: a hint that would
 * open under the tour (the classroom's first-open hint, when the tour opens the
 * built-in course) waits until it is over.
 */
let tourActive = false;
const tourListeners = new Set<() => void>();

export function setTourActive(active: boolean): void {
  if (tourActive === active) return;
  tourActive = active;
  for (const listener of tourListeners) listener();
}

export function useTourActive(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      tourListeners.add(onChange);
      return () => tourListeners.delete(onChange);
    },
    () => tourActive,
    () => false,
  );
}
