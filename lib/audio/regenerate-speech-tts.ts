/**
 * Per-speech managed-TTS helpers for the timeline editor.
 *
 * New audio receives an allocated pool identity from `generateAndStoreTTS`.
 * The old `tts_s<sceneOrder>_<actionId>` shape remains only as a compatibility
 * read/delete key for documents and cached rows created before allocation.
 */
import { db } from '@/lib/device-storage/database';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';
import { generateAndStoreTTS } from '@/lib/hooks/use-scene-generator';
import { useStageStore } from '@/lib/store/stage';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { mayGenerateForStage } from '@/lib/classroom/generation-permission';

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
  action: { id?: string; audioId?: string; audioInvalidated?: boolean },
): Promise<string | undefined> {
  if (action.audioId || action.audioInvalidated || !action.id) return undefined;
  const legacyId = speechAudioId(sceneOrder, action.id);
  return (await db.audioFiles.get(legacyId)) ? legacyId : undefined;
}

/**
 * Managed (server) TTS is on: the workspace's tts slot resolves to a provider
 * other than browser speech, which has no cached file to manage.
 */
export function isManagedTtsActive(): boolean {
  return serverTTSAvailable();
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

/** Object URL for the audio this id currently resolves to (caller revokes). */
export async function audioObjectUrl(audioId: string): Promise<string | null> {
  const blob = await resolveAudioBlob(audioId);
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * Discard the cached audio for a speech line — its stamped audioId (the
 * allocated pool identity, when present) and the legacy derived key — so the
 * line reads as "not voiced" until regenerated. Called when the user edits a
 * line's text: the cached audio is keyed by sceneOrder+actionId and the
 * stamped id, not the text, so without this the stale blob would keep
 * replaying for the new wording. Only the local compatibility copy is removed
 * here. The pool entry is left alone on purpose, and it does not need a
 * browser to release it: the same edit clears the action's audio fields
 * (`setSpeechTextClearAudioById`), so the next document write stops naming the
 * id, the server stamps the entry that just lost its last reference, and the
 * collector releases it after the grace period — the bytes following after
 * their own. An id nothing ever named is expired on `ASSET_PENDING_TTL_MS`
 * instead. Deleting from here would be refused anyway, and would race that
 * write.
 */
export async function discardSpeechAudio(
  sceneOrder: number,
  action: { id?: string; audioId?: string },
): Promise<void> {
  if (!action.id) return;
  const ids = new Set([speechAudioId(sceneOrder, action.id)]);
  if (action.audioId) ids.add(action.audioId);
  await db.audioFiles.bulkDelete([...ids]);
}

/**
 * (Re)generate TTS for one speech line.
 *
 * The clip always gets a fresh allocation (see `generateAndStoreTTS`): another
 * document may hold the old id, and no browser can prove it does not. Returns
 * the id on success, or null when TTS isn't applicable.
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
  // Regenerating narration calls the TTS provider and allocates a fresh pool
  // asset, so it is gated exactly like every other way generation starts. The
  // surfaces withhold the control too; refusing here keeps the two one rule.
  if (!mayGenerateForStage(stageId)) return null;
  return generateAndStoreTTS(requestId, text, language, signal, undefined, stageId);
}
