import { create } from 'zustand';
import type { IndexableTypeArray } from 'dexie';
import { db, type Snapshot } from '@/lib/utils/database';
import { useStageStore } from './stage';
import type { Scene } from '@/lib/types/stage';

export interface SnapshotState {
  // State
  snapshotCursor: number; // Snapshot pointer
  snapshotLength: number; // Snapshot count

  // Computed
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Actions
  setSnapshotCursor: (cursor: number) => void;
  setSnapshotLength: (length: number) => void;
  initSnapshotDatabase: () => Promise<void>;
  addSnapshot: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

/**
 * Snapshot store for undo/redo functionality
 * Based on PPTist's snapshot store, migrated to Zustand
 *
 * Uses IndexedDB (via Dexie) to store snapshot history
 */
export const useSnapshotStore = create<SnapshotState>((set, get) => ({
  // Initial state
  snapshotCursor: -1,
  snapshotLength: 0,

  // Computed properties
  canUndo: () => get().snapshotCursor > 0,
  canRedo: () => get().snapshotCursor < get().snapshotLength - 1,

  // Actions
  setSnapshotCursor: (cursor: number) => set({ snapshotCursor: cursor }),
  setSnapshotLength: (length: number) => set({ snapshotLength: length }),

  /**
   * Initialize snapshot database with current state
   */
  initSnapshotDatabase: async () => {
    const stageStore = useStageStore.getState();

    const newFirstSnapshot = {
      index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
      slides: JSON.parse(JSON.stringify(stageStore.scenes)),
    };
    await db.snapshots.add(newFirstSnapshot);

    set({
      snapshotCursor: 0,
      snapshotLength: 1,
    });
  },

  /**
   * Add a new snapshot to the history
   * Handles snapshot length limit and cursor position
   */
  addSnapshot: async () => {
    const stageStore = useStageStore.getState();
    const { snapshotCursor } = get();

    // Get all snapshot IDs from IndexedDB
    const allKeys = await db.snapshots.orderBy('id').keys();

    let needDeleteKeys: IndexableTypeArray = [];

    // If cursor is not at the end, delete all snapshots after cursor
    // This happens when user undoes multiple times then performs a new action
    if (snapshotCursor >= 0 && snapshotCursor < allKeys.length - 1) {
      needDeleteKeys = allKeys.slice(snapshotCursor + 1);
    }

    // Add new snapshot
    const snapshot = {
      index: stageStore.getSceneIndex(stageStore.currentSceneId || ''),
      slides: JSON.parse(JSON.stringify(stageStore.scenes)),
    };
    await db.snapshots.add(snapshot);

    // Calculate new snapshot length
    let snapshotLength = allKeys.length - needDeleteKeys.length + 1;

    // Enforce snapshot length limit
    const snapshotLengthLimit = 20;
    if (snapshotLength > snapshotLengthLimit) {
      needDeleteKeys.push(allKeys[0]);
      snapshotLength--;
    }

    // Maintain page focus after undo: set the second-to-last snapshot's index to current scene
    // https://github.com/pipipi-pikachu/PPTist/issues/27
    if (snapshotLength >= 2) {
      const currentSceneIndex = stageStore.getSceneIndex(stageStore.currentSceneId || '');
      await db.snapshots.update(allKeys[snapshotLength - 2] as number, {
        index: currentSceneIndex,
      });
    }

    // Delete obsolete snapshots
    await db.snapshots.bulkDelete(needDeleteKeys as number[]);

    set({
      snapshotCursor: snapshotLength - 1,
      snapshotLength,
    });
  },

  /**
   * Undo: restore previous snapshot
   */
  undo: async () => {
    const { snapshotCursor } = get();
    if (snapshotCursor <= 0) return;

    const stageStore = useStageStore.getState();

    const newSnapshotCursor = snapshotCursor - 1;
    const snapshots: Snapshot[] = await db.snapshots.orderBy('id').toArray();
    const snapshot = snapshots[newSnapshotCursor];
    const { index, slides } = snapshot;

    const sceneIndex = index > slides.length - 1 ? slides.length - 1 : index;

    // Restore scenes and current scene
    stageStore.setScenes(slides as unknown as Scene[]); // Type assertion needed due to Slide vs Scene difference
    if (slides[sceneIndex]) {
      stageStore.setCurrentSceneId(slides[sceneIndex].id);
    }

    set({ snapshotCursor: newSnapshotCursor });
  },

  /**
   * Redo: restore next snapshot
   */
  redo: async () => {
    const { snapshotCursor, snapshotLength } = get();
    if (snapshotCursor >= snapshotLength - 1) return;

    const stageStore = useStageStore.getState();

    const newSnapshotCursor = snapshotCursor + 1;
    const snapshots: Snapshot[] = await db.snapshots.orderBy('id').toArray();
    const snapshot = snapshots[newSnapshotCursor];
    const { index, slides } = snapshot;

    const sceneIndex = index > slides.length - 1 ? slides.length - 1 : index;

    // Restore scenes and current scene
    stageStore.setScenes(slides as unknown as Scene[]); // Type assertion needed due to Slide vs Scene difference
    if (slides[sceneIndex]) {
      stageStore.setCurrentSceneId(slides[sceneIndex].id);
    }

    set({ snapshotCursor: newSnapshotCursor });
  },
}));
