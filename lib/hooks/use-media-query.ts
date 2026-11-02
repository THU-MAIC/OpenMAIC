'use client';

import { useSyncExternalStore } from 'react';

type Listener = () => void;
const stores = new Map<string, ReturnType<typeof createStore>>();

function createStore(query: string) {
  let media: MediaQueryList | undefined;
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? (media ?? window.matchMedia(query)).matches
        : false,
    subscribe(listener: Listener) {
      if (!media && typeof window.matchMedia === 'function') {
        media = window.matchMedia(query);
        media.addEventListener('change', emit);
      }
      // A unique wrapper also supports subscribing the same callback twice.
      const notify = () => listener();
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
        if (listeners.size === 0) {
          media?.removeEventListener('change', emit);
          media = undefined;
        }
      };
    },
  };
}

/** Share browser listeners by query; hydration uses the caller's server hint. */
export function useMediaQuery(query: string, serverMatches = false): boolean {
  let store = stores.get(query);
  if (!store) {
    store = createStore(query);
    stores.set(query, store);
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => serverMatches);
}
