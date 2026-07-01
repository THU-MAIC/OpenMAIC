/**
 * Module-level quiz-edit session — pure in-memory undo/redo for the quiz
 * content surface, mirroring `slide-edit-session` but over the structured
 * `QuizContent` DSL instead of a canvas.
 *
 * Like the slide session it writes every committed snapshot THROUGH to the
 * canonical `useStageStore` (auto-save via Dexie); this store only owns the
 * undo/redo timeline of an in-progress editing session and is torn down on
 * exit. There is deliberately no localStorage / "restore unsaved" UX — the
 * stage store is the source of truth.
 *
 * Two commit entry points:
 *   - `commit`     — a discrete structural edit (add/delete/reorder/toggle/
 *                    type-switch). Always a fresh undo step.
 *   - `commitText` — a coalescing text edit. Consecutive edits carrying the
 *                    same `coalesceKey` (e.g. typing into one field) fold into
 *                    a SINGLE undo step; every keystroke still writes through
 *                    so nothing is lost. Switching fields or any discrete
 *                    commit starts a new step.
 */

import { create } from 'zustand';
import { useStageStore } from '@/lib/store/stage';
import type { QuizContent } from '@/lib/types/stage';
import {
  commitQuizContent,
  createQuizEditHistory,
  redoQuiz,
  undoQuiz,
  type QuizEditHistory,
} from './quiz-edit-ops';

interface QuizEditSessionState {
  sceneId: string | null;
  history: QuizEditHistory | null;
  /** Identifies the field of the in-progress coalesced text edit, or null. */
  coalesceKey: string | null;

  /** Establish a fresh in-memory baseline for a scene. */
  seed: (sceneId: string, content: QuizContent) => void;
  /** Discrete structural edit — always its own undo step. */
  commit: (next: QuizContent) => void;
  /** Coalescing text edit — same key folds into one undo step. */
  commitText: (next: QuizContent, coalesceKey: string) => void;
  undo: () => void;
  redo: () => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useQuizEditSession = create<QuizEditSessionState>((set, get) => {
  const writeThrough = (next: QuizContent) => {
    const { sceneId } = get();
    if (!sceneId) return;
    useStageStore.getState().updateScene(sceneId, { content: next });
  };

  /** Adopt a new history, write its present through, and close any text burst. */
  const replace = (history: QuizEditHistory) => {
    const { history: prev } = get();
    if (history === prev) return;
    writeThrough(history.present);
    set({ history, coalesceKey: null });
  };

  return {
    sceneId: null,
    history: null,
    coalesceKey: null,

    seed: (sceneId, content) => {
      // Adopt the live scene content as the baseline without writing through:
      // an untouched scene shouldn't receive a redundant store write.
      set({ sceneId, history: createQuizEditHistory(content), coalesceKey: null });
    },

    commit: (next) => {
      const { history } = get();
      if (!history) return;
      replace(commitQuizContent(history, next));
    },

    commitText: (next, coalesceKey) => {
      const { history, coalesceKey: activeKey } = get();
      if (!history) return;
      if (next === history.present) return;
      writeThrough(next);
      if (activeKey === coalesceKey) {
        // Continue the current burst: replace present, no new undo step.
        set({ history: { ...history, present: next, future: [] } });
      } else {
        // Start a new burst: this push is the burst's single undo step.
        set({ history: commitQuizContent(history, next), coalesceKey });
      }
    },

    undo: () => {
      const { history } = get();
      if (!history) return;
      replace(undoQuiz(history));
    },

    redo: () => {
      const { history } = get();
      if (!history) return;
      replace(redoQuiz(history));
    },

    end: () => {
      set({ sceneId: null, history: null, coalesceKey: null });
    },
  };
});
