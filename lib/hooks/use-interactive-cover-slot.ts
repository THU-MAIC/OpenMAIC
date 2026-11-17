'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * How many live interactive covers render at once across the page. Each live
 * cover runs a sandboxed iframe; past this count the cards show the static
 * placeholder until a slot frees up (see `components/discovery/live-interactive-cover.tsx`).
 */
export const MAX_LIVE_INTERACTIVE_COVERS = 4;

/** Courses currently holding a live-cover slot, keyed by stage id. */
const holders = new Set<string>();
/** How many mounted surfaces share each held slot, keyed by stage id. */
const holderCounts = new Map<string, number>();
/** Waiters in arrival order; granted when a slot frees. */
const waiters: Array<{ key: string }> = [];
/** Subscribers re-read their snapshot whenever a slot changes hands. */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function grantWaiters(): void {
  let grantedAny = false;
  while (waiters.length > 0) {
    const next = waiters[0]!;
    if (holders.has(next.key)) {
      // A surface of a course that gained its slot while this one waited:
      // share it, the way an arriving duplicate would.
      waiters.shift();
      holderCounts.set(next.key, holderCounts.get(next.key)! + 1);
      grantedAny = true;
      continue;
    }
    if (holders.size >= MAX_LIVE_INTERACTIVE_COVERS) break; // it keeps waiting
    waiters.shift();
    holders.add(next.key);
    holderCounts.set(next.key, 1);
    grantedAny = true;
  }
  if (grantedAny) notify();
}

/** Register a surface of `key`; the returned withdraw releases its share. */
function acquire(key: string): () => void {
  const waiter = { key };
  let granted = false;
  if (holders.has(key)) {
    holderCounts.set(key, holderCounts.get(key)! + 1);
    granted = true;
  } else if (holders.size < MAX_LIVE_INTERACTIVE_COVERS) {
    holders.add(key);
    holderCounts.set(key, 1);
    granted = true;
  } else {
    waiters.push(waiter);
  }
  notify();
  return () => {
    const queued = waiters.indexOf(waiter);
    if (queued >= 0) waiters.splice(queued, 1);
    if (granted) {
      const remaining = (holderCounts.get(key) ?? 1) - 1;
      if (remaining > 0) holderCounts.set(key, remaining);
      else {
        holderCounts.delete(key);
        holders.delete(key);
        grantWaiters();
      }
    }
    notify();
  };
}

/**
 * Whether this course may render its live interactive cover right now.
 *
 * `key` is the course's stage id, so one course holds at most one slot no
 * matter how many surfaces show it (a second surface of a holding course
 * shares its slot); a null key (the card is off-screen, or the cover has
 * nothing to render) neither holds nor waits. Slots are
 * first-come-first-served: a course that arrives while every slot is taken
 * shows the static placeholder until an earlier one leaves the screen.
 */
export function useInteractiveCoverSlot(key: string | null): boolean {
  const holding = useSyncExternalStore(
    subscribe,
    () => key !== null && holders.has(key),
    () => false,
  );
  useEffect(() => {
    if (!key) return;
    return acquire(key);
  }, [key]);
  return holding;
}

/** Test seam: drop every slot and waiter. */
export function __resetInteractiveCoverSlotsForTesting(): void {
  holders.clear();
  holderCounts.clear();
  waiters.length = 0;
  listeners.clear();
}
