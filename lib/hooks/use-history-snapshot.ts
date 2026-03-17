import { useCallback } from 'react';
import { useSnapshotStore } from '@/lib/store/snapshot';

/**
 * Hook for managing history snapshots (undo/redo)
 *
 * Usage:
 * ```tsx
 * const { addHistorySnapshot, canUndo, canRedo, undo, redo } = useHistorySnapshot();
 *
 * // After making changes
 * await addHistorySnapshot();
 *
 * // Undo/Redo
 * if (canUndo) await undo();
 * if (canRedo) await redo();
 * ```
 */
export function useHistorySnapshot() {
  const addSnapshot = useSnapshotStore((state) => state.addSnapshot);
  const undo = useSnapshotStore((state) => state.undo);
  const redo = useSnapshotStore((state) => state.redo);
  const canUndo = useSnapshotStore((state) => state.canUndo);
  const canRedo = useSnapshotStore((state) => state.canRedo);

  /**
   * Add a snapshot to the history
   * Call this after any significant state change that should be undoable
   */
  const addHistorySnapshot = useCallback(async () => {
    await addSnapshot();
  }, [addSnapshot]);

  return {
    addHistorySnapshot,
    undo,
    redo,
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}
