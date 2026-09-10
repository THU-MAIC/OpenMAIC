import { create } from 'zustand';
import type { Scene } from '@/lib/types/stage';

/**
 * Single-slot recycle bin for the Pro mode slide-nav rail's toast-undo.
 *
 * When the user deletes a slide from the rail, the deleted scene + its
 * original array index are pushed here so a "Undo" affordance in the
 * delete toast can restore the scene at its prior position. The slot
 * holds at most one entry — a subsequent delete evicts the previous
 * pending undo (matching Figma's recycle semantics).
 *
 * Restoring the scene happens at the call site by re-inserting it into
 * `useStageStore.scenes` at the recorded index; this store only owns
 * the snapshot, not the restoration logic.
 */

interface RecycleEntry {
  readonly scene: Scene;
  readonly index: number;
  /** Cleared if the auto-dismiss timer has already fired. */
  readonly stageId: string;
}

interface DeletedSceneRecycleState {
  pending: RecycleEntry | null;
  capture: (scene: Scene, index: number) => void;
  consume: () => RecycleEntry | null;
  clear: () => void;
}

export const useDeletedSceneRecycle = create<DeletedSceneRecycleState>()((set, get) => ({
  pending: null,
  capture: (scene, index) => set({ pending: { scene, index, stageId: scene.stageId } }),
  consume: () => {
    const entry = get().pending;
    if (entry) set({ pending: null });
    return entry;
  },
  clear: () => set({ pending: null }),
}));
