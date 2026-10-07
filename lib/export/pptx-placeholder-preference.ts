'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether PPTX exports include placeholder slides for interactive, quiz and
 * PBL scenes. A per-browser preference: on by default, kept in localStorage,
 * and read as the default whenever storage is unavailable.
 */
export const PPTX_PLACEHOLDERS_STORAGE_KEY = 'openmaic:export:pptx-placeholders';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readIncludePptxPlaceholders(
  storage: PreferenceStorage | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(PPTX_PLACEHOLDERS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

const listeners = new Set<() => void>();

export function writeIncludePptxPlaceholders(
  value: boolean,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(PPTX_PLACEHOLDERS_STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable: the choice lasts until the page reloads.
  }
  memoryValue = value;
  for (const listener of listeners) listener();
}

// The last written value, so the choice holds for this page even when
// storage refuses it.
let memoryValue: boolean | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => memoryValue ?? readIncludePptxPlaceholders();
const getServerSnapshot = () => true;

/** The preference and its setter, shared by every component that uses it. */
export function useIncludePptxPlaceholders(): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setValue = useCallback((next: boolean) => writeIncludePptxPlaceholders(next), []);
  return [value, setValue];
}
