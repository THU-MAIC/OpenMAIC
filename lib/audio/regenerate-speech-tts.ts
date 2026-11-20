/**
 * Per-speech managed-TTS helpers for the timeline editor.
 *
 * New audio receives an allocated pool identity from `generateAndStoreTTS`.
 * The old `tts_s<sceneOrder>_<actionId>` shape remains only as a compatibility
 * read/delete key for documents and cached rows created before allocation.
 */
import { db } from '@/lib/device-storage/database';
import { serverTTSAvailable } from '@/lib/audio/tts-selection';
import { generateAndStoreTTS } from '@/lib/audio/narration-tts';
import { mossCourseSubject, narrationSpokenText, precedingSpeechTexts } from '@/lib/audio/moss-tts';
import { useStageStore } from '@/lib/store/stage';
import { resolveAudioBlob } from '@/lib/media/resolve-audio-bytes';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import { AUDIO_PRESENCE_BATCH_SIZE } from '@/lib/media/audio-presence';
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

// Timeline rows mount together. Coalesce their checks before accessing Dexie or HTTP.
let pending = new Map<string, Array<(exists: boolean) => void>>();

export function audioExists(audioId: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!pending.size)
      queueMicrotask(async () => {
        const batch = pending;
        pending = new Map();
        const found = await audioExistsBulk([...batch.keys()]).catch(() => new Set<string>());
        for (const [id, listeners] of batch) for (const notify of listeners) notify(found.has(id));
      });
    const listeners = pending.get(audioId) ?? [];
    listeners.push(resolve);
    pending.set(audioId, listeners);
  });
}

export async function audioExistsBulk(audioIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(audioIds)];
  if (!ids.length) return new Set();
  const cached = await db.audioFiles.bulkGet(ids).catch(() => []);
  const found = new Set(ids.filter((_, i) => cached[i]));
  const remote = ids.filter((id) => !found.has(id) && mayNameAPoolAsset(id) && id.length <= 128);
  for (let i = 0; i < remote.length; i += AUDIO_PRESENCE_BATCH_SIZE) {
    const chunk = remote.slice(i, i + AUDIO_PRESENCE_BATCH_SIZE);
    const query = new URLSearchParams(chunk.map((id) => ['id', id]));
    try {
      const response = await fetch('/api/persistence/audio-presence?' + query, {
        cache: 'no-store',
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (Array.isArray(body.ids)) {
        for (const id of chunk) if (body.ids.includes(id)) found.add(id);
      }
    } catch {
      /* Offline: clips from the local cache are still playable. */
    }
  }
  return found;
}

/** Object URL for the audio this id currently resolves to (caller revokes). */
export async function audioObjectUrl(audioId: string): Promise<string | null> {
  const blob = await resolveAudioBlob(audioId);
  return blob ? URL.createObjectURL(blob) : null;
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
  action: { id?: string; text?: string; spokenText?: string; audioId?: string },
  language?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!isManagedTtsActive()) return null;
  const rawText = action.text?.trim();
  if (!rawText || !action.id) return null;
  const requestId = `tts_request_s${sceneOrder}_${action.id}`;
  const { stage, scenes } = useStageStore.getState();
  const stageId = stage?.id;
  // Regenerating narration calls the TTS provider and allocates a fresh pool
  // asset, so it is gated exactly like every other way generation starts. The
  // surfaces withhold the control too; refusing here keeps the two one rule.
  if (!mayGenerateForStage(stageId)) return null;
  const scene = scenes.find((item) => item.order === sceneOrder);
  const live = scene?.actions?.find((item) => item.type === 'speech' && item.id === action.id);
  const spokenText =
    action.spokenText ??
    (live?.type === 'speech' && live.text?.trim() === rawText ? live.spokenText : undefined);
  const text = narrationSpokenText({ text: rawText, spokenText });
  const previousTexts = scene ? precedingSpeechTexts(scenes, scene.id, action.id) : [];
  const subject = mossCourseSubject(stage);
  const options =
    previousTexts.length || subject
      ? { ...(previousTexts.length ? { previousTexts } : {}), ...(subject ? { subject } : {}) }
      : undefined;
  return generateAndStoreTTS(requestId, text, language, signal, options, stageId);
}
