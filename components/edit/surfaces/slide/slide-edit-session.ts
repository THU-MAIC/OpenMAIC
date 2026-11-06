/**
 * Which slide the editor canvas is on, and the one path its edits take to the
 * stage store.
 *
 * The stage store is the only copy of the content: every operation reads it
 * first, so a change that reached the store from elsewhere (an agent, another
 * surface) is built on rather than overwritten. Undo and redo live on the course
 * timeline (`lib/edit/course-timeline.ts`).
 */

import { create } from 'zustand';
import {
  applyEditorTransaction,
  type EditorOperation,
  type EditorTransaction,
} from '@openmaic/editor/core';
import { commitCourseEdit } from '@/lib/edit/course-edit';
import { commitSlideEdit, deriveSlideEditOperations } from '@/lib/edit/scene-edit-bridge';
import { migrateSlideContent } from '@/lib/edit/slide-schema';
import { useStageStore } from '@/lib/store/stage';
import type { SlideContent } from '@/lib/types/stage';

interface SlideEditSessionState {
  sceneId: string | null;

  /** Point the session at a scene. */
  seed: (sceneId: string) => void;
  /** Apply one canonical op (numeric inspectors, future affordances). */
  applyOp: (op: EditorOperation) => void;
  /** Apply a fully described editor transaction to the canonical document. */
  applyTransaction: (transaction: EditorTransaction) => void;
  /** Apply only while the transaction still belongs to the captured scene. */
  applyTransactionForScene: (sceneId: string, transaction: EditorTransaction) => void;
  /**
   * Fold a renderer-committed snapshot in, and save it. `sceneId`: the scene `next`
   * was built from.
   */
  commitContent: (sceneId: string, next: SlideContent) => void;
  /**
   * Hold what the canvas measured (text auto-height), with no edit behind it: no
   * step and no save. It goes out with the next real edit of the scene.
   */
  commitMeasurement: (sceneId: string, next: SlideContent) => void;
  /** Tear the session down on exit from edit mode. */
  end: () => void;
}

const AUTO_SIZE_FIELDS: ReadonlySet<string> = new Set(['width', 'height']);
const TEXT_EDIT_FIELDS: ReadonlySet<string> = new Set([
  'content',
  'text',
  'data',
  'width',
  'height',
]);
const TEXT_OPERATIONS: ReadonlySet<string> = new Set([
  'text.updateContent',
  'shape.updateTextContent',
  'table.updateCell',
]);

function canonicalContent(sceneId: string): SlideContent | null {
  const scene = useStageStore.getState().scenes.find((candidate) => candidate.id === sceneId);
  return scene?.type === 'slide' ? migrateSlideContent(scene.content as SlideContent) : null;
}

function writeContent(sceneId: string, next: SlideContent): void {
  useStageStore.getState().updateScene(sceneId, { content: next });
}

/** The burst a commit belongs to: one text element's content, edited in one go. */
function textBurstOf(
  sceneId: string,
  previous: SlideContent,
  next: SlideContent,
): string | undefined {
  const operations = deriveSlideEditOperations(previous, next);
  const [first] = operations;
  if (operations.length !== 1 || first.type !== 'element.update') return undefined;
  const keys = Object.keys(first.patch);
  if (!keys.every((key) => TEXT_EDIT_FIELDS.has(key))) return undefined;
  if (keys.every((key) => AUTO_SIZE_FIELDS.has(key))) return undefined;
  return `text:${sceneId}:${first.elementId}`;
}

function transactionTextBurst(sceneId: string, transaction: EditorTransaction): string | undefined {
  const ids = new Set(
    transaction.operations.map((operation) =>
      TEXT_OPERATIONS.has(operation.type) && 'elementId' in operation ? operation.elementId : null,
    ),
  );
  const [id] = ids;
  return ids.size === 1 && id ? `text:${sceneId}:${id}` : undefined;
}

export const useSlideEditSession = create<SlideEditSessionState>((set, get) => {
  const apply = (sceneId: string, transaction: EditorTransaction) => {
    const content = canonicalContent(sceneId);
    if (!content) return;
    const next = applyEditorTransaction(content, transaction);
    if (next === content) return;
    // `neutral` is auto-layout: written, never a step. `navigate` is the text
    // editor walking its own history, so it belongs to that text's burst.
    if (transaction.history === 'neutral') {
      writeContent(sceneId, next);
      return;
    }
    commitCourseEdit({ coalesceKey: transactionTextBurst(sceneId, transaction) }, () =>
      writeContent(sceneId, next),
    );
  };

  return {
    sceneId: null,

    seed: (sceneId) => set({ sceneId }),

    applyOp: (op) => {
      const { sceneId } = get();
      const content = sceneId ? canonicalContent(sceneId) : null;
      if (!sceneId || !content) return;
      // Legacy toolbar actions may arrive after their selected element was
      // deleted. Keep that one-operation UI path a silent no-op as before;
      // explicit transactions remain strict so callers cannot hide invalid
      // batch operations behind this compatibility behavior.
      if (
        'elementId' in op &&
        !content.canvas.elements.some((element) => element.id === op.elementId)
      ) {
        return;
      }
      apply(sceneId, { origin: 'toolbar', history: 'record', operations: [op] });
    },

    applyTransaction: (transaction) => {
      const { sceneId } = get();
      if (sceneId) apply(sceneId, transaction);
    },

    applyTransactionForScene: (sceneId, transaction) => {
      if (get().sceneId === sceneId) apply(sceneId, transaction);
    },

    commitContent: (sceneId, next) => {
      const content = canonicalContent(sceneId);
      if (!content) return;
      // The legacy Canvas still emits complete snapshots while the renderer
      // editor is feature-flagged. Keep this compatibility bridge isolated
      // to that fallback until its React surface moves into @openmaic/editor.
      const committed = commitSlideEdit({ past: [], present: content, future: [] }, next);
      if (committed.present === content) return;
      commitCourseEdit({ coalesceKey: textBurstOf(sceneId, content, next) }, () =>
        writeContent(sceneId, committed.present),
      );
    },

    commitMeasurement: (sceneId, next) => {
      useStageStore.getState().updateSceneMeasurement(sceneId, next);
    },

    end: () => set({ sceneId: null }),
  };
});
