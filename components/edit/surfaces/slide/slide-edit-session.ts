/**
 * Module-level slide-edit session.
 *
 * EditShell invokes a surface's `useSurfaceState()` and renders its
 * `CanvasComponent` as siblings (state hook on the shell, canvas as a child
 * of the frame). They must share one `SlideEditHistory`, so it lives in a
 * store rather than component state — the same idiom the rest of the
 * renderer uses (useCanvasStore / useStageStore).
 *
 * Pure orchestration over the already-tested kernel (`slide-ops`), the
 * scene-context bridge (`scene-edit-bridge`) and the #571 persistence
 * layer. `seed` deliberately does NOT persist: it establishes the
 * in-memory baseline without clobbering any localStorage history the user
 * has not yet chosen to restore. Persistence starts on the first real
 * mutation (applyOp / commitContent) or once `restore` adopts it.
 */

import { create } from 'zustand';
import { commitSlideEdit } from '@/lib/edit/scene-edit-bridge';
import {
  clearPersistedSlideHistory,
  hasPersistedSlideHistory,
  persistSlideHistory,
} from '@/lib/edit/slide-history-persistence';
import { migrateSlideContent } from '@/lib/edit/slide-schema';
import {
  applySlideEditOperation,
  createSlideEditHistory,
  redoSlideEditOperation,
  undoSlideEditOperation,
} from '@/lib/edit/slide-ops';
import type { SlideEditHistory, SlideEditOperation } from '@/lib/edit/slide-ops';
import type { SlideContent } from '@/lib/types/stage';

interface SlideEditSessionState {
  sceneId: string | null;
  history: SlideEditHistory | null;
  /**
   * Decided once at `seed` (before any renderer mount write): does this
   * scene have persisted history from a *previous* session that the user
   * should be offered to restore?
   */
  pendingRestore: boolean;

  /** Establish a fresh in-memory baseline for a scene (does not persist). */
  seed: (sceneId: string, content: SlideContent) => void;
  /** Adopt a persisted history wholesale (user chose "restore"). */
  restore: (sceneId: string, history: SlideEditHistory) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: SlideEditOperation) => void;
  /**
   * Fold a renderer-committed snapshot in. `isUserEdit` is the causal
   * discriminator: a real geometry gesture commits synchronously inside a
   * pointer interaction, whereas the renderer's ResizeObserver
   * normalization (text auto-height) commits with no pointer gesture in
   * flight. Non-user commits update the baseline only — no undo step, no
   * persistence, so the restore prompt never fires from normalization.
   */
  commitContent: (next: SlideContent, isUserEdit: boolean) => void;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useSlideEditSession = create<SlideEditSessionState>((set, get) => {
  const replace = (history: SlideEditHistory) => {
    const { sceneId, history: prev } = get();
    if (history === prev) return;
    set({ history });
    if (!sceneId) return;
    // `replace()` only runs for user actions (applyOp/commit/undo/redo).
    // An empty `past` therefore means pristine: either never edited, or
    // undone all the way back to the seeded baseline (undo replays to the
    // original present; the non-user normalization path uses raw `set`,
    // never `replace`). Persisting that would make a later entry fire a
    // spurious restore prompt with nothing meaningful to restore.
    if (history.past.length === 0) {
      clearPersistedSlideHistory(sceneId);
    } else {
      persistSlideHistory(sceneId, history);
    }
  };

  return {
    sceneId: null,
    history: null,
    pendingRestore: false,

    seed: (sceneId, content) => {
      set({
        sceneId,
        history: createSlideEditHistory(migrateSlideContent(content)),
        // Captured now, before the renderer mounts and writes anything.
        pendingRestore: hasPersistedSlideHistory(sceneId),
      });
    },

    restore: (sceneId, history) => {
      set({
        sceneId,
        history: {
          past: history.past.map(migrateSlideContent),
          present: migrateSlideContent(history.present),
          future: history.future.map(migrateSlideContent),
        },
        pendingRestore: false,
      });
    },

    applyOp: (op) => {
      const { history } = get();
      if (!history) return;
      replace(applySlideEditOperation(history, op));
    },

    commitContent: (next, isUserEdit) => {
      const { history } = get();
      if (!history) return;
      if (!isUserEdit) {
        // Renderer normalization (no pointer gesture, e.g. text
        // auto-height reflow). Fold into `present` only — never a new
        // undo step, never persisted, and crucially do NOT reset
        // past/future: this reflow can fire right after a user resize,
        // and wiping the stack would silently break undo/redo.
        set({ history: { ...history, present: next } });
        return;
      }
      replace(commitSlideEdit(history, next));
    },

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoSlideEditOperation(history));
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoSlideEditOperation(history));
    },

    end: () => {
      set({ sceneId: null, history: null, pendingRestore: false });
    },
  };
});
