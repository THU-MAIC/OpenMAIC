/**
 * Whiteboard History Store
 *
 * Lightweight in-memory store that saves snapshots of whiteboard elements
 * before destructive operations (clear, replace). Allows users to browse
 * and restore previous whiteboard states.
 *
 * History is per-session (not persisted to IndexedDB) to keep things simple.
 */

import { create } from 'zustand';
import type { PPTElement } from '@/lib/types/slides';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';

export interface WhiteboardSnapshot {
  /** Deep copy of whiteboard elements at the time of capture */
  elements: PPTElement[];
  /** Timestamp when the snapshot was taken */
  timestamp: number;
  /** Cached fingerprint used for deduplication and no-op restore checks */
  fingerprint: string;
}

interface WhiteboardHistoryState {
  /** Stack of snapshots, newest last */
  snapshots: WhiteboardSnapshot[];
  /** Maximum number of snapshots to keep */
  maxSnapshots: number;
  // Actions
  /** Save a snapshot of the current whiteboard elements */
  pushSnapshot: (elements: PPTElement[]) => void;
  /** Get a snapshot by index */
  getSnapshot: (index: number) => WhiteboardSnapshot | null;
  /** Clear all history */
  clearHistory: () => void;
}

export const useWhiteboardHistoryStore = create<WhiteboardHistoryState>((set, get) => ({
  snapshots: [],
  maxSnapshots: 20,

  pushSnapshot: (elements) => {
    // Don't save empty snapshots
    if (!elements || elements.length === 0) return;

    const { snapshots } = get();
    const newFingerprint = elementFingerprint(elements);
    if (snapshots.some((s) => s.fingerprint === newFingerprint)) {
      return;
    }

    const snapshot: WhiteboardSnapshot = {
      elements: JSON.parse(JSON.stringify(elements)), // Deep copy
      timestamp: Date.now(),
      fingerprint: newFingerprint,
    };

    set((state) => {
      const newSnapshots = [...state.snapshots, snapshot];
      // Enforce limit: drop oldest snapshots first.
      if (newSnapshots.length > state.maxSnapshots) {
        return { snapshots: newSnapshots.slice(-state.maxSnapshots) };
      }
      return { snapshots: newSnapshots };
    });
  },

  getSnapshot: (index) => {
    const { snapshots } = get();
    return snapshots[index] ?? null;
  },

  clearHistory: () => set({ snapshots: [] }),
}));
