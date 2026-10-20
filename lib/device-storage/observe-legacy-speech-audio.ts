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
