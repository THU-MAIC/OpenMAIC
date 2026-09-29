/**
 * Device-local IndexedDB storage.
 *
 * Durable user data -- courses, chat history, learner progress and the bytes
 * of generated media -- lives on the server, behind the HTTP persistence
 * seams. What stays in this browser is what belongs to this device and may be
 * lost without losing anything the server does not also hold:
 *
 * - `audioFiles` / `mediaFiles`: a local copy of narration and generated media
 *   the pool already stores (it saves a re-download), plus bytes a full store
 *   refused, kept so a Retry re-attempts the upload instead of paying a
 *   provider again, and per-element failure records so a refused or failed
 *   generation is not retried on every reload;
 * - `imageFiles`: PDF page images staged between upload and generation;
 * - `snapshots`: the editor's undo/redo history;
 * - `voiceProfiles`: TTS voice profiles registered from this browser (a
 *   provider setting, like the rest of the settings kept in localStorage);
 * - `autoVoiceCache`: reference clips for re-registering auto voices.
 *
 * This is a database of its own (`maic-device-cache`), separate from the
 * pre-server browser database (`MAIC-Database`), which is read-only and kept
 * only for the one-way importer (see `lib/legacy-browser-storage`). Clearing
 * the local cache deletes this database and nothing else.
 */
import Dexie, { type EntityTable } from 'dexie';

import type { Scene } from '@/lib/types/stage';

/** Editor undo/redo snapshot. */
export interface Snapshot {
  id?: number;
  index: number;
  slides: Scene[];
}

/** Narration audio (TTS): a cached copy of a pool asset, or refused bytes kept for a retry. */
export interface AudioFileRecord {
  id: string; // Primary key (audio id)
  /** Stage ownership index. */
  stageId?: string;
  /** The derived id a mirror was written for; retry recovery reads it. */
  originAudioId?: string;
  /** The URL a mirror was fetched from, for retry recovery. */
  originAudioUrl?: string;
  blob: Blob; // Audio binary data
  duration?: number; // Duration (seconds)
  format: string; // mp3, wav, etc.
  text?: string; // Corresponding text content
  voice?: string; // Voice used
  createdAt: number;
  ossKey?: string; // Full CDN URL for this audio blob
}

/** Staged image bytes (PDF page images between upload and generation). */
export interface ImageFileRecord {
  id: string; // Primary key
  blob: Blob | ArrayBuffer; // Image binary data
  filename: string; // Original filename
  mimeType: string; // image/png, image/jpeg, etc.
  size: number; // File size (bytes)
  createdAt: number;
}

/**
 * Generated media (images/videos): a cached copy of a pool asset, refused bytes
 * kept for a retry, or a failure record (`error` set, empty blob).
 */
export interface MediaFileRecord {
  // Compound key: `${stageId}:${mediaRef}`.
  id: string;
  stageId: string;
  /** Original gen_* reference retained after allocation for reload reconciliation. */
  placeholderRef?: string;
  type: 'image' | 'video';
  blob: Blob; // Media binary
  mimeType: string; // image/png, video/mp4
  size: number;
  poster?: Blob; // Video thumbnail blob
  prompt: string; // Original prompt (for retry)
  params: string; // JSON-serialized generation params
  error?: string; // If set, this is a failed task (blob is empty placeholder)
  errorCode?: string; // Structured error code (e.g. 'CONTENT_SENSITIVE')
  ossKey?: string; // Full CDN URL for this media blob
  posterOssKey?: string; // Full CDN URL for the poster blob
  createdAt: number;
}

/** Browser-local TTS voice profile. */
export interface VoiceProfileRecord {
  id: string;
  providerId: string;
  kind: 'prompt' | 'clone';
  name: string;
  voicePrompt?: string;
  promptText?: string;
  referenceAudio?: Blob;
  referenceAudioName?: string;
  referenceAudioMimeType?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Cached reference clip for a registered auto voice (any TTS provider). The
 * clip is the source of truth; the deterministic `voiceId` is its key, enabling
 * register-on-invalid re-registration after backend GC/restart.
 */
export interface AutoVoiceCacheRecord {
  voiceId: string;
  referenceAudio: Blob;
  mimeType: string;
  updatedAt: number;
}

/** Build the compound primary key for mediaFiles: `${stageId}:${elementId}` */
export function mediaFileKey(stageId: string, elementId: string): string {
  return `${stageId}:${elementId}`;
}

export const DEVICE_DATABASE_NAME = 'maic-device-cache';

interface DeviceMetaRecord {
  key: string;
  value: unknown;
}

/**
 * Set once browser-local voice profiles from the pre-server database have been
 * copied here (or there was nothing to copy), so a profile the user deletes
 * afterwards is not brought back from the old copy.
 */
const VOICE_PROFILES_CARRIED_OVER = 'legacy-voice-profiles-carried-over';

class DeviceDatabase extends Dexie {
  audioFiles!: EntityTable<AudioFileRecord, 'id'>;
  mediaFiles!: EntityTable<MediaFileRecord, 'id'>;
  imageFiles!: EntityTable<ImageFileRecord, 'id'>;
  snapshots!: EntityTable<Snapshot, 'id'>;
  voiceProfiles!: EntityTable<VoiceProfileRecord, 'id'>;
  autoVoiceCache!: EntityTable<AutoVoiceCacheRecord, 'voiceId'>;
  meta!: EntityTable<DeviceMetaRecord, 'key'>;

  constructor() {
    super(DEVICE_DATABASE_NAME);
    this.version(1).stores({
      audioFiles: 'id, stageId, createdAt',
      mediaFiles: 'id, stageId, [stageId+type]',
      imageFiles: 'id, createdAt',
      snapshots: '++id',
      voiceProfiles: 'id, providerId, kind, updatedAt',
      autoVoiceCache: 'voiceId, updatedAt',
      meta: 'key',
    });
    // Runs before the first query of every open (sticky), so no reader sees
    // the table before the carry-over. Queries inside must go through the VIP
    // handle Dexie passes in; the regular one waits for this very handler.
    this.on('ready', (vip) => carryOverLegacyVoiceProfiles(vip as DeviceDatabase), true);
  }
}

/** Set by a clear: the profiles it deleted must not be copied back from the old database. */
let carryOverSuppressed = false;

/**
 * Voice profiles are a provider setting the user created in this browser, and
 * they used to live in the pre-server database. Copy them here once (reading
 * that database, never writing it) so upgrading does not lose them.
 * Best-effort: a failed read leaves the marker unset and retries on the next
 * open, and never blocks the device cache from opening.
 */
async function carryOverLegacyVoiceProfiles(database: DeviceDatabase): Promise<void> {
  try {
    if (await database.meta.get(VOICE_PROFILES_CARRIED_OVER)) return;
    if (carryOverSuppressed) {
      await database.meta.put({ key: VOICE_PROFILES_CARRIED_OVER, value: true });
      return;
    }
    const { readLegacyVoiceProfiles } = await import('@/lib/legacy-browser-storage');
    const legacy = await readLegacyVoiceProfiles();
    await database.transaction('rw', [database.voiceProfiles, database.meta], async () => {
      // A profile saved here already wins over its old copy.
      const present = new Set(
        (await database.voiceProfiles.bulkGet(legacy.map((profile) => profile.id)))
          .filter((profile) => profile !== undefined)
          .map((profile) => profile.id),
      );
      await database.voiceProfiles.bulkPut(legacy.filter((profile) => !present.has(profile.id)));
      await database.meta.put({ key: VOICE_PROFILES_CARRIED_OVER, value: true });
    });
  } catch (error) {
    console.warn('Could not carry over browser-local voice profiles:', error);
  }
}

/** The device-local database. Opens lazily on first use. */
export const db = new DeviceDatabase();

/**
 * Delete the whole device-local database. The next access reopens it empty.
 * Server data and the read-only pre-server database are not touched.
 */
export async function clearDeviceStorage(): Promise<void> {
  // Clearing includes the voice profiles; their old copies must not come back
  // when the database reopens.
  carryOverSuppressed = true;
  // Keep auto-open: a cache read later in this page reopens an empty database
  // instead of failing with DatabaseClosedError.
  await db.delete({ disableAutoOpen: false });
  await db.open();
}
