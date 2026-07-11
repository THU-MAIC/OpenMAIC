import type { DiscussionAction } from '@/lib/types/action';
import type { LectureNoteEntry, LectureNoteItem } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';

const LECTURE_NOTE_ACTION_TYPES = new Set([
  'speech',
  'spotlight',
  'laser',
  'play_video',
  'discussion',
  'widget_highlight',
  'widget_setState',
  'widget_annotation',
  'widget_reveal',
]);

export function buildLectureNotes(scenes: readonly Scene[]): LectureNoteEntry[] {
  return scenes
    .filter((scene) => scene.actions && scene.actions.length > 0)
    .map((scene) => ({
      sceneId: scene.id,
      sceneTitle: scene.title,
      sceneOrder: scene.order,
      items: scene
        .actions!.map((action, actionIndex): LectureNoteItem | null => {
          if (!LECTURE_NOTE_ACTION_TYPES.has(action.type)) return null;
          const base = {
            actionIndex,
            actionId: action.id,
            actionType: action.type,
          };
          if (action.type === 'speech') {
            return {
              ...base,
              kind: 'speech',
              text: action.text,
            };
          }
          return {
            ...base,
            kind: 'action',
            type: action.type,
            label: action.type === 'discussion' ? (action as DiscussionAction).topic : undefined,
          };
        })
        .filter((item): item is LectureNoteItem => item !== null),
      completedAt: scene.updatedAt || scene.createdAt || 0,
    }))
    .sort((a, b) => a.sceneOrder - b.sceneOrder);
}
