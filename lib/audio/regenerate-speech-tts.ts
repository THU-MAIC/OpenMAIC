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
import { proveExclusiveAssetOwnership } from '@/lib/media/collect-stage-asset-refs';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { assetRefExists } from '@/lib/media/use-asset-url';

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

/** Object URL for the audio this id currently resolves to (caller revokes). */
export async function audioObjectUrl(audioId: string): Promise<string | null> {
  const blob = await resolveAudioBlob(audioId);
  return blob ? URL.createObjectURL(blob) : null;
}

/**
 * The current audio id when it is pool-backed and provably owned by this stage
 * alone, so its bytes may be replaced in place; undefined otherwise.
 */
async function exclusivelyOwnedAudioId(
  audioId: string | undefined,
  stageId: string | undefined,
): Promise<string | undefined> {
  if (!audioId || !stageId) return undefined;
  if (!(await assetRefExists(audioId))) return undefined;
  const { exclusive } = await proveExclusiveAssetOwnership(audioId, stageId);
  return exclusive ? audioId : undefined;
}

/**
 * (Re)generate TTS for one speech line.
 *
 * A clip this line exclusively owns keeps its id and has its bytes replaced, so
 * references stay valid and no orphan entry or compatibility row is left behind
 * — the same rule media retries follow. A clip shared with another element or
 * document, or one whose ownership cannot be proven, gets a fresh allocation so
 * the other holders keep their audio. Returns the id on success, or null when
 * TTS isn't applicable.
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
  const replaceAssetId = await exclusivelyOwnedAudioId(action.audioId, stageId);
  return generateAndStoreTTS(requestId, text, language, signal, undefined, replaceAssetId, stageId);
}
