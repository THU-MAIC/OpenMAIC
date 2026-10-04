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
 * - `snapshots`: the editor's undo/redo history;
 * - `voiceProfiles`: TTS voice profiles registered from this browser (a
 *   provider setting, like the rest of the settings kept in localStorage);
 * - `autoVoiceCache`: reference clips for re-registering auto voices;
 * - `courseThumbnails`: the home library's derived course thumbnails (a
 *   course's first slide and its media bytes), so a reload shows them without
 *   reading the course again (see `lib/utils/course-thumbnail-cache.ts`).
 *
 * This is a database of its own (`maic-device-cache`), separate from the
 * pre-server browser database (`MAIC-Database`), which is read-only and kept
 * only for the one-way importer (see `lib/legacy-browser-storage`). Clearing
 * the local cache deletes this database and nothing else.
 */
import Dexie, { type EntityTable, type Table } from 'dexie';

import type { Slide } from '@openmaic/dsl';

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

/**
 * A course's home-library thumbnail, derived from the course's first slide.
 * Keyed by the owner it was read as and the course; valid only for the
 * course version (`updatedAt`) it was derived from.
 */
export interface CourseThumbnailRecord {
  /** One-way digest of the owner the thumbnail was read as (never the owner id itself). */
  ownerKey: string;
  stageId: string;
  /** The course's `updatedAt` the thumbnail was derived from. */
  version: number;
  /** The first slide with its media slots that held bytes emptied, or null: the course has none. */
  slide: Slide | null;
  /** The bytes of those media slots, by slot index (`slideMediaReferenceSlots` order). */
  media: Array<{ slot: number; blob: Blob }>;
  /** Total media bytes, for the cache's size bound. */
  bytes: number;
  /** Last time the thumbnail was stored or shown, for eviction. */
  usedAt: number;
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
  snapshots!: EntityTable<Snapshot, 'id'>;
  voiceProfiles!: EntityTable<VoiceProfileRecord, 'id'>;
  autoVoiceCache!: EntityTable<AutoVoiceCacheRecord, 'voiceId'>;
  courseThumbnails!: Table<CourseThumbnailRecord, [string, string]>;
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
    // Version 2 drops `imageFiles`, where document images were staged between
    // upload and a generation the browser ran. Runs read uploaded materials on
    // the server; the upgrade deletes the table with whatever it still held.
    this.version(2).stores({ imageFiles: null });
    // Version 3 adds the home library's course thumbnails.
    this.version(3).stores({ courseThumbnails: '[ownerKey+stageId], usedAt' });
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
