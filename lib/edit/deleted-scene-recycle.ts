import { create } from 'zustand';
import type { Scene } from '@/lib/types/stage';
import type { Stage } from '@/lib/types/stage';
import { createLogger } from '@/lib/logger';

const log = createLogger('DeletedSceneRecycle');
export const DELETED_SCENE_UNDO_MS = 5000;

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

export interface RecycleEntry {
  readonly scene: Scene;
  readonly index: number;
  /** Cleared if the auto-dismiss timer has already fired. */
  readonly stageId: string;
  readonly assetRefs: readonly string[];
  readonly manifestEntries: NonNullable<Stage['videoManifest']>;
}

interface DeletedSceneRecycleState {
  pending: RecycleEntry | null;
  capture: (
    scene: Scene,
    index: number,
    assetRefs?: readonly string[],
    manifestEntries?: NonNullable<Stage['videoManifest']>,
  ) => void;
  consume: () => RecycleEntry | null;
  expire: () => RecycleEntry | null;
  clear: () => void;
}

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function cancelExpiry(): void {
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

export async function finalizeDeletedSceneReclamation(entry: RecycleEntry): Promise<void> {
  const [{ flushStageSave }, { reclaimUnreferencedStageAssetsForStage }] = await Promise.all([
    import('@/lib/store/stage'),
    import('@/lib/media/reclaim-stage-assets'),
  ]);
  await flushStageSave();
  await reclaimUnreferencedStageAssetsForStage(entry.stageId, entry.assetRefs);
}

function finalize(entry: RecycleEntry): void {
  void finalizeDeletedSceneReclamation(entry).catch((error) => {
    log.warn(`Failed to reclaim assets for expired scene ${entry.scene.id}:`, error);
  });
}

export const useDeletedSceneRecycle = create<DeletedSceneRecycleState>()((set, get) => ({
  pending: null,
  capture: (scene, index, assetRefs = [], manifestEntries = {}) => {
    const previous = get().pending;
    cancelExpiry();
    if (previous) finalize(previous);
    const entry = { scene, index, stageId: scene.stageId, assetRefs, manifestEntries };
    set({ pending: entry });
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      if (get().pending !== entry) return;
      set({ pending: null });
      finalize(entry);
    }, DELETED_SCENE_UNDO_MS);
  },
  consume: () => {
    const entry = get().pending;
    if (entry) {
      cancelExpiry();
      set({ pending: null });
    }
    return entry;
  },
  expire: () => {
    const entry = get().pending;
    if (entry) {
      cancelExpiry();
      set({ pending: null });
      finalize(entry);
    }
    return entry;
  },
  clear: () => {
    cancelExpiry();
    set({ pending: null });
  },
}));
