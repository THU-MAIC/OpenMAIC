/**
 * Per-speech managed-TTS helpers for the timeline editor.
 *
 * New audio receives an allocated pool identity from `generateAndStoreTTS`.
 * The old `tts_s<sceneOrder>_<actionId>` shape remains only as a compatibility
 * read/delete key for documents and Dexie rows created before allocation.
 */
import { db } from '@/lib/utils/database';
import { useSettingsStore } from '@/lib/store/settings';
import { generateAndStoreTTS } from '@/lib/hooks/use-scene-generator';
import { useStageStore } from '@/lib/store/stage';
import { reclaimUnreferencedStageAssetsForStage } from '@/lib/media/reclaim-stage-assets';

/** Legacy deterministic Dexie key used before pool allocation. */
export function speechAudioId(sceneOrder: number, actionId: string): string {
  return `tts_s${sceneOrder}_${actionId}`;
}

/**
 * Return only the identity stamped on the action. Allocated ids cannot be
 * reconstructed: no audioId means no current audio reference.
 */
export function resolveSpeechAudioId(
  _sceneOrder: number,
  action: { id?: string; audioId?: string },
): string | undefined {
  return action.audioId;
}

/** Locate a pre-allocation Dexie row for a legacy action with no audioId. */
export async function resolveLegacySpeechAudioId(
  sceneOrder: number,
  action: { id?: string; audioId?: string },
): Promise<string | undefined> {
  if (action.audioId || !action.id) return undefined;
  const legacyId = speechAudioId(sceneOrder, action.id);
  return (await db.audioFiles.get(legacyId)) ? legacyId : undefined;
}

/** Managed (server) TTS is on — browser-native TTS has no cached file to manage. */
export function isManagedTtsActive(): boolean {
  const s = useSettingsStore.getState();
  return s.ttsEnabled && s.ttsProviderId !== 'browser-native-tts';
}

/** True if an audio blob is cached under this exact audioId. */
export async function audioExists(audioId: string): Promise<boolean> {
  return !!(await db.audioFiles.get(audioId));
}

/** Existence for many audioIds in one IndexedDB round-trip. */
export async function audioExistsBulk(audioIds: string[]): Promise<Set<string>> {
  if (audioIds.length === 0) return new Set();
  const recs = await db.audioFiles.bulkGet(audioIds);
  const have = new Set<string>();
  recs.forEach((r, i) => {
    if (r) have.add(audioIds[i]);
  });
  return have;
}

/** Object URL for the audio cached under this exact audioId (caller revokes). */
export async function audioObjectUrl(audioId: string): Promise<string | null> {
  const rec = await db.audioFiles.get(audioId);
  return rec ? URL.createObjectURL(rec.blob) : null;
}

/**
 * Discard the cached audio for a speech line (both its stamped audioId, if any,
 * and the canonical derived key). Called when the user edits a line's text: the
 * stamped allocated id is independent of the text, and a legacy derived row is
 * too, so without this the stale blob could keep replaying for the new wording.
 * After this the line reads as "not voiced" and must be regenerated.
 */
export async function discardSpeechAudio(
  sceneOrder: number,
  action: { id?: string; audioId?: string },
): Promise<void> {
  if (!action.id) return;
  const ids = new Set([speechAudioId(sceneOrder, action.id)]);
  if (action.audioId) ids.add(action.audioId);
  const stageId = useStageStore.getState().stage?.id;
  if (stageId) {
    await reclaimUnreferencedStageAssetsForStage(stageId, [...ids]);
  } else {
    await db.audioFiles.bulkDelete([...ids]);
  }
}

/** Remove a previously committed allocated id after its replacement is stamped. */
export async function removeSupersededSpeechAudio(
  previousAudioId: string | undefined,
  currentAudioId: string,
): Promise<void> {
  if (!previousAudioId || previousAudioId === currentAudioId) return;
  const stageId = useStageStore.getState().stage?.id;
  if (stageId) {
    await reclaimUnreferencedStageAssetsForStage(stageId, [previousAudioId]);
  } else {
    await db.audioFiles.delete(previousAudioId);
  }
}

/**
 * (Re)generate TTS for one speech line under a fresh allocated asset id.
 * Returns that id on success, or null when TTS isn't applicable.
 */
export async function regenerateSpeechAudio(
  sceneOrder: number,
  action: { id?: string; text?: string; audioId?: string },
  language?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isManagedTtsActive()) return null;
  const text = action.text?.trim();
  if (!text || !action.id) return null;
  const requestId = `tts_request_s${sceneOrder}_${action.id}`;
  const stageId = useStageStore.getState().stage?.id;
  return generateAndStoreTTS(requestId, text, language, signal, undefined, undefined, stageId);
}
