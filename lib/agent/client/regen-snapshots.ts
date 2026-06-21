'use client';

/**
 * Snapshot store for `regenerate_scene` "restore previous" support.
 *
 * Whole-slide regeneration applies directly to the canvas (snappy), but it
 * overwrites whatever the user had — including hand-edits. Before applying, the
 * runtime snapshots the pre-regenerate scene here, keyed by toolCallId, so the
 * tool card can offer a "还原到重生成前 / Restore previous" button that does not
 * rely on the user remembering Ctrl+Z.
 */
import { create } from 'zustand';
import type { Action } from '@/lib/types/action';
import type { SceneContent } from '@/lib/types/stage';

export interface RegenSnapshot {
  sceneId: string;
  content: SceneContent;
  actions: Action[];
  /**
   * Narration-only regen (`regenerate_scene_actions`): the slide content was NOT
   * changed, so Restore must revert ONLY the actions — re-applying the snapshot
   * content would clobber any canvas edits the user made since, and needlessly
   * reseed the slide edit session.
   */
  actionsOnly?: boolean;
  restored: boolean;
}

/** Re-applies the snapshot to the stage store (injected so the store stays testable). */
export type RestoreApplyFn = (
  sceneId: string,
  patch: { content?: SceneContent; actions: Action[] },
) => void;

interface RegenSnapshotsState {
  snapshots: Record<string, RegenSnapshot>;
  setSnapshot: (toolCallId: string, snap: Omit<RegenSnapshot, 'restored'>) => void;
  restore: (toolCallId: string, apply: RestoreApplyFn) => void;
  /** Drop all snapshots (e.g. on "新对话") so stale entries don't accumulate. */
  clearAll: () => void;
}

export const useRegenSnapshots = create<RegenSnapshotsState>((set, get) => ({
  snapshots: {},
  setSnapshot: (toolCallId, snap) =>
    set((s) => ({
      snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: false } },
    })),
  restore: (toolCallId, apply) => {
    const snap = get().snapshots[toolCallId];
    if (!snap || snap.restored) return;
    apply(
      snap.sceneId,
      snap.actionsOnly
        ? { actions: snap.actions }
        : { content: snap.content, actions: snap.actions },
    );
    set((s) => ({
      snapshots: { ...s.snapshots, [toolCallId]: { ...snap, restored: true } },
    }));
  },
  clearAll: () => set({ snapshots: {} }),
}));
