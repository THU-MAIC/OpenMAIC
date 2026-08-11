/**
 * Module-level slide-edit session — pure in-memory undo/redo for the editor
 * canvas.
 *
 * EditShell invokes a surface's `useSurfaceState()` and renders its
 * `SurfaceComponent` as siblings (state hook on the shell, canvas as a child
 * of the frame). They must share one `SlideEditHistory`, so it lives in a
 * store rather than component state — the same idiom the rest of the
 * renderer uses (useCanvasStore / useStageStore).
 *
 * Edits are written through to the canonical stage store by the canvas
 * controller (`useSlideCanvasController` in `use-slide-surface.ts`); this
 * store only tracks the undo/redo timeline of an in-progress editing
 * session. It deliberately does NOT persist to localStorage: the canonical
 * stage store is the source of truth and already auto-persists via Dexie,
 * so there is nothing "unsaved" to recover on reload — no "restore unsaved
 * changes" UX, by design.
 */

import { create } from 'zustand';
import {
  applyEditorTransaction,
  createEditorHistory,
  redoEditorTransaction,
  undoEditorTransaction,
  type EditorHistory,
  type EditorOperation,
  type EditorTransaction,
} from '@openmaic/editor/core';
import { commitSlideEdit } from '@/lib/edit/scene-edit-bridge';
import { migrateSlideContent } from '@/lib/edit/slide-schema';
import type { SlideEditHistory } from '@/lib/edit/slide-ops';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';

interface SlideEditSessionState {
  sceneId: string | null;
  history: EditorHistory | null;
  /** True while the legacy canvas holds an uncommitted pointer gesture locally. */
  gestureActive: boolean;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: SlideContent) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: EditorOperation) => void;
  /** Apply a fully described editor transaction to the canonical document. */
  applyTransaction: (transaction: EditorTransaction) => void;
  /** Apply only while the transaction still belongs to the captured scene. */
  applyTransactionForScene: (sceneId: string, transaction: EditorTransaction) => void;
  /**
   * Fold a renderer-committed snapshot in. `isUserEdit` is the causal
   * discriminator: a real gesture commits synchronously inside a pointer
   * interaction, whereas the renderer's ResizeObserver normalization (text
   * auto-height) commits with no pointer gesture in flight. Non-user
   * commits update `present` only — no new undo step, so `past` is left
   * untouched (the reflow can chase a user resize and wiping the undo
   * stack would silently break undo). `future` IS cleared, though: once
   * `present` is replaced by the normalized content it has diverged from
   * whatever the redo branch pointed at, so those stale entries are no
   * longer valid continuations.
   */
  commitContent: (next: SlideContent, isUserEdit: boolean) => void;
  setGestureActive: (active: boolean) => void;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useSlideEditSession = create<SlideEditSessionState>((set, get) => {
  /**
   * Write the new canonical content through to the stage store (auto-save).
   * Single point of write-through so undo, redo, applyOp, user
   * commitContent, and ResizeObserver normalization all stay in lockstep
   * with `useStageStore`. Stage updates fire first so renderer subscribers
   * (SceneProvider reads via `currentSlideContent`) see the new content as
   * soon as React processes the next batch.
   */
  const writeThrough = (next: SlideContent) => {
    const { sceneId } = get();
    if (!sceneId) return;
    useStageStore.getState().updateScene(sceneId, { content: next });
  };

  const replace = (history: EditorHistory) => {
    const { history: prev } = get();
    if (history === prev) return;
    writeThrough(history.present);
    set({ history });
  };

  return {
    sceneId: null,
    history: null,
    gestureActive: false,

    seed: (sceneId, content) => {
      // Adopt the live scene content as the in-memory baseline. We do NOT
      // write-through here: if the user makes no edits, the stage store
      // shouldn't receive a redundant write. Any schema migration the
      // first user edit triggers will naturally flow back through
      // commitContent's writeThrough.
      set({
        sceneId,
        history: createEditorHistory(migrateSlideContent(content)),
        gestureActive: false,
      });
    },

    applyOp: (op) => {
      const { history } = get();
      if (!history) return;
      // Legacy toolbar actions may arrive after their selected element was
      // deleted. Keep that one-operation UI path a silent no-op as before;
      // explicit transactions remain strict so callers cannot hide invalid
      // batch operations behind this compatibility behavior.
      if (
        'elementId' in op &&
        !history.present.canvas.elements.some((element) => element.id === op.elementId)
      ) {
        return;
      }
      replace(
        applyEditorTransaction(history, {
          origin: 'toolbar',
          history: 'record',
          operations: [op],
        }),
      );
    },

    applyTransaction: (transaction) => {
      const { history } = get();
      if (!history) return;
      replace(applyEditorTransaction(history, transaction));
    },

    applyTransactionForScene: (sceneId, transaction) => {
      const { history, sceneId: currentSceneId } = get();
      if (!history || currentSceneId !== sceneId) return;
      replace(applyEditorTransaction(history, transaction));
    },

    commitContent: (next, isUserEdit) => {
      const { history } = get();
      if (!history) return;
      if (!isUserEdit) {
        // ResizeObserver / auto-height normalization: don't push an undo
        // step (the reflow can chase a user resize and wiping `past` would
        // silently break undo), but DO write through — the auto-fit height
        // IS the new canonical state. Clear `future`, though: `present` now
        // holds the normalized content, which has diverged from whatever
        // the redo branch pointed at, so replaying those stale entries
        // would discard this normalization. Leaving them would let a later
        // redo silently revert to pre-undo content (canvas/store divergence).
        writeThrough(next);
        set({ history: { ...history, present: next, future: [] } });
        return;
      }
      // The legacy Canvas still emits complete snapshots while the renderer
      // editor is feature-flagged. Keep this compatibility bridge isolated
      // to that fallback until its React surface moves into @openmaic/editor.
      replace(
        commitSlideEdit(history as unknown as SlideEditHistory, next) as unknown as EditorHistory,
      );
    },

    setGestureActive: (gestureActive) => set({ gestureActive }),

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoEditorTransaction(history));
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoEditorTransaction(history));
    },

    end: () => {
      set({ sceneId: null, history: null, gestureActive: false });
    },
  };
});
