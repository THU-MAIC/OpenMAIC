/**
 * Which quiz the form is on, and the path its edits take to the stage store,
 * which holds the only copy of the content. Undo and redo live on the course
 * timeline (`lib/edit/course-timeline.ts`).
 *
 * Two commit entry points:
 *   - `commit`     — a discrete structural edit (add/delete/reorder/toggle/
 *                    type-switch). Always a fresh step.
 *   - `commitText` — a coalescing text edit. Consecutive edits carrying the
 *                    same `coalesceKey` (e.g. typing into one field) fold into
 *                    a SINGLE step; every keystroke still writes through so
 *                    nothing is lost. Switching fields or any discrete commit
 *                    starts a new step.
 */

import { create } from 'zustand';
import { commitCourseEdit } from '@/lib/edit/course-edit';
import { useStageStore } from '@/lib/store/stage';
import type { QuizContent } from '@/lib/types/stage';

interface QuizEditSessionState {
  sceneId: string | null;

  /** Point the session at a scene. */
  seed: (sceneId: string) => void;
  /** Discrete structural edit — always its own step. */
  commit: (next: QuizContent) => void;
  /** Coalescing text edit — same key folds into one step. */
  commitText: (next: QuizContent, coalesceKey: string) => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

export const useQuizEditSession = create<QuizEditSessionState>((set, get) => {
  const write = (next: QuizContent, coalesceKey?: string) => {
    const { sceneId } = get();
    if (!sceneId) return;
    commitCourseEdit(
      { coalesceKey: coalesceKey ? `quiz:${sceneId}:${coalesceKey}` : undefined },
      () => useStageStore.getState().updateScene(sceneId, { content: next }),
    );
  };

  return {
    sceneId: null,
    seed: (sceneId) => set({ sceneId }),
    commit: (next) => write(next),
    commitText: (next, coalesceKey) => write(next, coalesceKey),
    end: () => set({ sceneId: null }),
  };
});
