/**
 * Device-only rows of the old database, copied into the device cache
 * (`maic-device-cache`) in its current shape, so this browser behaves like one
 * that never upgraded:
 *
 * - `mediaFiles` failure records (for example `CONTENT_SENSITIVE`): without
 *   them a refused element would lose its refusal;
 * - `mediaFiles` rows still holding bytes for a generation placeholder the
 *   course carries: its Retry adopts them instead of paying a provider
 *   again;
 * - `audioFiles` rows of the course whose derived key a speech action still
 *   carries: narration adoption uploads them on the next open;
 * - `autoVoiceCache` reference clips: re-registering an auto voice after a
 *   provider-side reset keeps the course's voice.
 *
 * Rows are keyed by the course's server id. A row the device cache already has
 * is left as it is (the device copy is newer), and bytes the importer already
 * uploaded are not copied again: the document no longer names them.
 */
import { db, mediaFileKey, type MediaFileRecord } from '@/lib/device-storage/database';
import type { AppDocument } from '@/lib/document-store';
import {
  readLegacyAudioFile,
  readLegacyAutoVoiceCache,
  readLegacyMediaFiles,
} from '@/lib/legacy-browser-storage';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';

import { collectDocumentMediaRefs } from './media';

function isFailureRecord(row: MediaFileRecord): boolean {
  return typeof row.error === 'string' && row.error !== '' && !(row.blob?.size > 0);
}

function elementIdOf(row: MediaFileRecord, legacyStageId: string): string {
  const prefix = `${legacyStageId}:`;
  return row.id.startsWith(prefix) ? row.id.slice(prefix.length) : row.id;
}

/** Copy one course's device-only rows. Returns how many rows were written. */
export async function copyCourseDeviceRows(
  document: AppDocument,
  legacyStageId: string,
): Promise<number> {
  const stageId = document.stage.id;
  const { slides, speech } = collectDocumentMediaRefs(document);
  let written = 0;

  for (const row of await readLegacyMediaFiles(legacyStageId)) {
    const elementId = elementIdOf(row, legacyStageId);
    const keep =
      isFailureRecord(row) ||
      (row.blob?.size > 0 && isGeneratedMediaPlaceholder(elementId) && slides.has(elementId));
    if (!keep) continue;
    const id = mediaFileKey(stageId, elementId);
    if (await db.mediaFiles.get(id)) continue;
    await db.mediaFiles.put({ ...row, id, stageId });
    written += 1;
  }

  for (const audioId of speech.keys()) {
    const row = await readLegacyAudioFile(audioId);
    // Only rows that name this course: a row keyed by audio id alone could be
    // another course's clip (see narration adoption's ownership rule).
    if (!row || row.stageId !== legacyStageId || !(row.blob?.size > 0)) continue;
    if (await db.audioFiles.get(audioId)) continue;
    await db.audioFiles.put({ ...row, stageId });
    written += 1;
  }
  return written;
}

/** Copy the auto-voice reference clips the device cache does not have yet. */
export async function copyAutoVoiceCache(): Promise<number> {
  const legacy = await readLegacyAutoVoiceCache();
  if (legacy.length === 0) return 0;
  return db.transaction('rw', db.autoVoiceCache, async () => {
    const present = new Set(
      (await db.autoVoiceCache.bulkGet(legacy.map((row) => row.voiceId)))
        .filter((row) => row !== undefined)
        .map((row) => row.voiceId),
    );
    const missing = legacy.filter((row) => !present.has(row.voiceId));
    await db.autoVoiceCache.bulkPut(missing);
    return missing.length;
  });
}
