/**
 * Read access to what browser storage held before persistence moved to the
 * server.
 *
 * READ-ONLY. Used only by the one-way importer that moves a browser's existing
 * courses to the server (and by the one-time carry-over of browser-local voice
 * profiles into the device cache, `lib/device-storage/database.ts`). Do not
 * add writes, and do not read from here on the regular load and save paths:
 * courses, chat, learner runtime and media are served by the HTTP persistence
 * seams, and anything still only here reaches the server through the importer.
 *
 * Four IndexedDB databases are covered:
 *
 * - `MAIC-Database` (Dexie, `./schema.ts`): the original tables -- stages,
 *   scenes and outlines from before the document store, chat sessions,
 *   playback rows, generated media and narration bytes, the agent roster
 *   mirror, folders and folder membership;
 * - `maic-documents`: course documents written by the browser document store;
 * - `maic-runtime`: learner runtime sessions (chat, quiz attempts, PBL,
 *   playback) written by the browser runtime store, partitioned by the device
 *   learner key (`lib/runtime/learner-key.ts`);
 * - `maic-asset-pool`: asset bytes written by the browser asset pool.
 *
 * Every accessor first checks that the database exists and answers empty when
 * it does not: opening an IndexedDB database creates it, and a browser that
 * never stored anything locally must not gain empty databases from a probe.
 * The store views expose read methods only.
 */
import Dexie from 'dexie';
import {
  BrowserAssetStore,
  BrowserDocumentStore,
  BrowserRuntimeStore,
  type DocumentStore,
  type RuntimeStore,
} from '@openmaic/storage';

import type { LegacyDocumentSnapshot, LegacyDocumentStore } from '@/lib/document-store/migration';
import type { AppStage } from '@/lib/document-store/persistence-types';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import type { AppScene } from '@/lib/types/stage';

import {
  LEGACY_DATABASE_NAME,
  LegacyBrowserDatabase,
  type AudioFileRecord,
  type ChatSessionRecord,
  type FolderRecord,
  type GeneratedAgentRecord,
  type MediaFileRecord,
  type PlaybackStateRecord,
  type StageFolderMembership,
  type StageRecord,
  type VoiceProfileRecord,
} from './schema';

export type * from './schema';
export { LEGACY_DATABASE_NAME } from './schema';

/** IndexedDB names of the browser document, runtime and asset stores. */
export const LEGACY_DOCUMENTS_DATABASE_NAME = 'maic-documents';
export const LEGACY_RUNTIME_DATABASE_NAME = 'maic-runtime';
export const LEGACY_ASSET_POOL_DATABASE_NAME = 'maic-asset-pool';

async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  return Dexie.exists(name);
}

let legacyDatabase: Promise<LegacyBrowserDatabase | null> | undefined;

/** The Dexie database, or null when this browser never created it. */
function openLegacyDatabase(): Promise<LegacyBrowserDatabase | null> {
  legacyDatabase ??= databaseExists(LEGACY_DATABASE_NAME)
    .then(async (exists) => {
      if (!exists) return null;
      const database = new LegacyBrowserDatabase();
      await database.open();
      return database;
    })
    .catch((error: unknown) => {
      // Not cached: a transient failure must not hide the data for the page.
      legacyDatabase = undefined;
      throw error;
    });
  return legacyDatabase;
}

/** Whether any pre-server browser storage exists in this browser. */
export async function hasLegacyBrowserStorage(): Promise<boolean> {
  const names = [
    LEGACY_DATABASE_NAME,
    LEGACY_DOCUMENTS_DATABASE_NAME,
    LEGACY_RUNTIME_DATABASE_NAME,
    LEGACY_ASSET_POOL_DATABASE_NAME,
  ];
  const found = await Promise.all(names.map(databaseExists));
  return found.some(Boolean);
}

// ==================== MAIC-Database (Dexie) ====================

/** Pre-document-store course aggregates, in the shape the document migration reads. */
export function readLegacyDocumentSnapshots(): LegacyDocumentStore {
  return {
    async read(stageId): Promise<LegacyDocumentSnapshot | null> {
      const database = await openLegacyDatabase();
      if (!database) return null;
      return database.transaction(
        'r',
        [database.stages, database.scenes, database.stageOutlines],
        async () => {
          const [stage, scenes, outline] = await Promise.all([
            database.stages.get(stageId),
            database.scenes.where('stageId').equals(stageId).sortBy('order'),
            database.stageOutlines.get(stageId),
          ]);
          return stage ? { stage, scenes, outline } : null;
        },
      );
    },
    async listStages(): Promise<StageRecord[]> {
      const database = await openLegacyDatabase();
      return database ? database.stages.toArray() : [];
    },
  };
}

/** Chat sessions of one course, including rows a backup restore had staged. */
export async function readLegacyChatSessions(stageId: string): Promise<ChatSessionRecord[]> {
  const database = await openLegacyDatabase();
  if (!database) return [];
  const staged = await database.chatRestoreStaging
    .where('stageId')
    .equals(stageId)
    .sortBy('createdAt');
  if (staged.length > 0) return staged;
  return database.chatSessions.where('stageId').equals(stageId).sortBy('createdAt');
}

export async function readLegacyPlaybackState(
  stageId: string,
): Promise<PlaybackStateRecord | undefined> {
  const database = await openLegacyDatabase();
  return database ? database.playbackState.get(stageId) : undefined;
}

export async function readLegacyGeneratedAgents(stageId: string): Promise<GeneratedAgentRecord[]> {
  const database = await openLegacyDatabase();
  return database ? database.generatedAgents.where('stageId').equals(stageId).toArray() : [];
}

export async function readLegacyFolders(): Promise<FolderRecord[]> {
  const database = await openLegacyDatabase();
  if (!database) return [];
  return (await database.folders.toArray()).sort((a, b) => a.order - b.order);
}

export async function readLegacyStageFolders(): Promise<StageFolderMembership[]> {
  const database = await openLegacyDatabase();
  return database ? database.stageFolders.toArray() : [];
}

/** Generated media rows of one course (bytes, posters and failure records). */
export async function readLegacyMediaFiles(stageId: string): Promise<MediaFileRecord[]> {
  const database = await openLegacyDatabase();
  return database ? database.mediaFiles.where('stageId').equals(stageId).toArray() : [];
}

/** One narration row by audio id. Rows from before `stageId` existed are keyed by id alone. */
export async function readLegacyAudioFile(audioId: string): Promise<AudioFileRecord | undefined> {
  const database = await openLegacyDatabase();
  return database ? database.audioFiles.get(audioId) : undefined;
}

export async function readLegacyVoiceProfiles(): Promise<VoiceProfileRecord[]> {
  const database = await openLegacyDatabase();
  return database ? database.voiceProfiles.toArray() : [];
}

// ==================== Browser document, runtime and asset stores ====================

/** The read half of a document store. */
export type LegacyDocumentReader = Pick<
  DocumentStore<AppScene, AppStage>,
  'loadDocument' | 'listDocuments'
>;

/** Course documents from the browser document store, or null when it was never created. */
export async function openLegacyDocumentReader(): Promise<LegacyDocumentReader | null> {
  if (!(await databaseExists(LEGACY_DOCUMENTS_DATABASE_NAME))) return null;
  const store = new BrowserDocumentStore<AppScene, AppStage>({
    dbName: LEGACY_DOCUMENTS_DATABASE_NAME,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
  });
  return {
    loadDocument: (stageId) => store.loadDocument(stageId),
    listDocuments: () => store.listDocuments(),
  };
}

/** The read half of a runtime store. */
export type LegacyRuntimeReader = Pick<RuntimeStore, 'getSession' | 'listSessions' | 'listRecords'>;

/** Learner runtime from the browser runtime store, or null when it was never created. */
export async function openLegacyRuntimeReader(): Promise<LegacyRuntimeReader | null> {
  if (!(await databaseExists(LEGACY_RUNTIME_DATABASE_NAME))) return null;
  const store = new BrowserRuntimeStore({
    dbName: LEGACY_RUNTIME_DATABASE_NAME,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  return {
    getSession: (sessionId) => store.getSession(sessionId),
    listSessions: (stageId, learnerKey) => store.listSessions(stageId, learnerKey),
    listRecords: (sessionId, opts) => store.listRecords(sessionId, opts),
  };
}

/** The read half of the browser asset pool. `resolve` answers an object URL the caller revokes. */
export interface LegacyAssetReader {
  resolve(ref: string): Promise<string | null>;
  exists(ref: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Asset bytes from the browser asset pool, or null when it was never created. */
export async function openLegacyAssetReader(): Promise<LegacyAssetReader | null> {
  if (!(await databaseExists(LEGACY_ASSET_POOL_DATABASE_NAME))) return null;
  const store = new BrowserAssetStore({ dbName: LEGACY_ASSET_POOL_DATABASE_NAME });
  return {
    resolve: (ref) => store.resolve(ref),
    exists: (ref) => store.exists(ref),
    close: () => store.close(),
  };
}

/** @internal Test-only reset of the memoized database handle. */
export function resetLegacyBrowserStorageForTests(): void {
  legacyDatabase = undefined;
}
