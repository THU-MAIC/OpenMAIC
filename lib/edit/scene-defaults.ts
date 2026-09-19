import { nanoid } from 'nanoid';
import type { Scene, QuizContent } from '@/lib/types/stage';
import { createBlankSlideScene } from '@/lib/edit/slide-defaults';

export type EditableSceneType = 'slide' | 'quiz';

/** Build the valid empty content used when a quiz first enters authoring. */
export function createBlankQuizScene(stageId: string, title: string, order: number): Scene {
  const content: QuizContent = { type: 'quiz', questions: [] };

  return {
    id: nanoid(),
    stageId,
    type: 'quiz',
    title,
    order,
    content,
    actions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Build a fresh scene for one of the page types exposed by the rail chooser. */
export function createBlankEditableScene(
  type: EditableSceneType,
  stageId: string,
  title: string,
  order: number,
): Scene {
  return type === 'slide'
    ? createBlankSlideScene(stageId, title, order)
    : createBlankQuizScene(stageId, title, order);
}

/**
 * Insert at an array index and keep persisted scene order aligned with the
 * visible rail. Clamping makes the helper safe for leading and trailing gaps.
 */
export function insertSceneAtIndex(
  scenes: readonly Scene[],
  scene: Scene,
  requestedIndex: number,
): Scene[] {
  const index = Math.max(0, Math.min(requestedIndex, scenes.length));
  const next = [...scenes.slice(0, index), scene, ...scenes.slice(index)];
  return next.map((item, itemIndex) =>
    item.order === itemIndex + 1 ? item : { ...item, order: itemIndex + 1 },
  );
}
