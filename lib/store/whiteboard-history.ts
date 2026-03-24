/**
 * Whiteboard History Store
 *
 * Saves snapshots of whiteboard elements before destructive operations
 * (clear, replace). Allows users to browse and restore previous states.
 *
 * History is scoped per-stage (stageId) and persisted to localStorage.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { PPTElement } from '@/lib/types/slides';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';

export interface WhiteboardSnapshot {
  /** Deep copy of whiteboard elements at the time of capture */
  elements: PPTElement[];
  /** Timestamp when the snapshot was taken */
  timestamp: number;
  /** Human-readable label shown in the history panel */
  label?: string;
  /** Cached fingerprint used for deduplication and no-op restore checks */
  fingerprint: string;
}

interface WhiteboardHistoryState {
  /** Snapshots grouped by stageId, newest last within each group */
  snapshotsByStage: Record<string, WhiteboardSnapshot[]>;
  /** Maximum number of snapshots to keep per stage */
  maxSnapshots: number;
  /** elementsKey of a just-restored snapshot; used to skip auto-snapshot once */
  restoredKey: string | null;

  // Actions
  /** Save a snapshot of the current whiteboard elements for a given stage */
  pushSnapshot: (stageId: string, elements: PPTElement[], label?: string) => void;
  /** Get all snapshots for a given stage */
  getSnapshots: (stageId: string) => WhiteboardSnapshot[];
  /** Get a snapshot by stage and index */
  getSnapshot: (stageId: string, index: number) => WhiteboardSnapshot | null;
  /** Clear history. If stageId is provided, clear only that stage; otherwise clear all. */
  clearHistory: (stageId?: string) => void;
  /** Set the restored key (elementsKey of the snapshot being restored) */
  setRestoredKey: (key: string | null) => void;
}

export const useWhiteboardHistoryStore = create<WhiteboardHistoryState>()(
  persist(
    (set, get) => ({
      snapshotsByStage: {},
      maxSnapshots: 20,
      restoredKey: null,

      pushSnapshot: (stageId, elements, label) => {
        // Don't save empty snapshots
        if (!stageId || !elements || elements.length === 0) return;

        const { snapshotsByStage, maxSnapshots } = get();
        const stageSnapshots = snapshotsByStage[stageId] ?? [];
        const newFingerprint = elementFingerprint(elements);

        // Skip duplicate consecutive snapshots
        if (
          stageSnapshots.length > 0 &&
          stageSnapshots[stageSnapshots.length - 1].fingerprint === newFingerprint
        ) {
          return;
        }

        const snapshot: WhiteboardSnapshot = {
          elements: JSON.parse(JSON.stringify(elements)), // Deep copy
          timestamp: Date.now(),
          label,
          fingerprint: newFingerprint,
        };

        const newSnapshots = [...stageSnapshots, snapshot];
        const trimmed =
          newSnapshots.length > maxSnapshots ? newSnapshots.slice(-maxSnapshots) : newSnapshots;

        set({
          snapshotsByStage: {
            ...snapshotsByStage,
            [stageId]: trimmed,
          },
        });
      },

      getSnapshots: (stageId) => {
        return get().snapshotsByStage[stageId] ?? [];
      },

      getSnapshot: (stageId, index) => {
        const stageSnapshots = get().snapshotsByStage[stageId] ?? [];
        return stageSnapshots[index] ?? null;
      },

      clearHistory: (stageId?) => {
        if (stageId) {
          const { snapshotsByStage } = get();
          const { [stageId]: _, ...rest } = snapshotsByStage;
          set({ snapshotsByStage: rest, restoredKey: null });
        } else {
          set({ snapshotsByStage: {}, restoredKey: null });
        }
      },

      setRestoredKey: (key) => set({ restoredKey: key }),
    }),
    {
      name: 'openmaic-whiteboard-history',
      partialize: (state) => ({ snapshotsByStage: state.snapshotsByStage }),
    },
  ),
);
