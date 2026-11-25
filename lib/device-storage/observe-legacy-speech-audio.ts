import { liveQuery } from 'dexie';
import { speechAudioId } from '@/lib/audio/regenerate-speech-tts';
import { rowBelongsToAction } from '@/lib/audio/adopt-cached-narration';
import { db } from '@/lib/device-storage/database';
import type { Scene } from '@/lib/types/stage';

/** Observe only device-cache evidence; course data remains in the document store. */
export function observeLegacySpeechAudio(
  scene: Pick<Scene, 'actions' | 'order' | 'stageId'>,
  next: (actionIds: Set<string>) => void,
  error: () => void,
): () => void {
  const subscription = liveQuery(async () => {
    const audio = new Set<string>();
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || action.audioId || action.audioInvalidated || !action.id)
        continue;
      const derivedRef = speechAudioId(scene.order, action.id);
      const row = await db.audioFiles.get(derivedRef);
      if (row && rowBelongsToAction(row, scene.stageId, { derivedRef, text: action.text })) {
        audio.add(action.id);
      }
    }
    return audio;
  }).subscribe({ next, error });
  return () => subscription.unsubscribe();
}

/**
 * The course-wide version of {@link observeLegacySpeechAudio}: one liveQuery
 * covering every scene, reporting per-scene evidence so a whole-course issue
 * list pays one table subscription instead of one per scene.
 */
export function observeLegacyCourseAudio(
  scenes: readonly Pick<Scene, 'actions' | 'order' | 'stageId' | 'id'>[],
  next: (audio: Map<string, Set<string>>) => void,
  error: () => void,
): () => void {
  const subscription = liveQuery(async () => {
    const audio = new Map<string, Set<string>>();
    for (const scene of scenes) {
      const actionIds = new Set<string>();
      for (const action of scene.actions ?? []) {
        if (action.type !== 'speech' || action.audioId || action.audioInvalidated || !action.id)
          continue;
        const derivedRef = speechAudioId(scene.order, action.id);
        const row = await db.audioFiles.get(derivedRef);
        if (row && rowBelongsToAction(row, scene.stageId, { derivedRef, text: action.text })) {
          actionIds.add(action.id);
        }
      }
      audio.set(scene.id, actionIds);
    }
    return audio;
  }).subscribe({ next, error });
  return () => subscription.unsubscribe();
}
