/**
 * Stage Storage Manager
 *
 * Manages multiple stage data in IndexedDB
 * Each stage has its own storage key based on stageId
 */

import { Stage, Scene } from '../types/stage';
import { ChatSession } from '../types/chat';
import { db } from './database';
import {
  ChatStorageLockUnavailableError,
  saveChatSessions,
  loadChatSessions,
  deleteChatSessions,
  type ChatStorageSnapshot,
} from './chat-storage';
import isEqual from 'lodash/isEqual';
import { clearCursor } from '@/lib/playback/cursor';
import {
  accessDocument,
  clearCurrentScene,
  getDocumentStore,
  getLegacyDocumentStore,
  loadCurrentScene,
  mutateDocument,
  saveCurrentScene,
  type AppDocumentOutline,
} from '@/lib/document-store';
import { clearAllForScene } from '@/lib/quiz/persistence';
import { beginStageRuntimeDeletionSafely } from '@/lib/runtime/store';
import { clearStageDrainWatermarks } from '@/lib/pbl/v2/runtime/drain';
import { createLogger } from '@/lib/logger';
import {
  withRuntimeStorageExclusiveLockUntilSettled,
  withRuntimeStorageSharedLock,
} from './chat-storage-lock';

const log = createLogger('StageStorage');

export interface StageStoreData {
  stage: Stage;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
  chatSnapshot?: ChatStorageSnapshot;
  /** The aggregate save contract treats omission as deletion; callers should carry this snapshot. */
  outline?: AppDocumentOutline;
}

export interface StageListItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

/**
 * Save stage data to IndexedDB
 */
export async function saveStageData(stageId: string, data: StageStoreData): Promise<void> {
  try {
    const now = Date.now();
    await mutateDocument(
      stageId,
      async (existing, store) => {
        // Lock order: per-stage document lock, then the global runtime epoch.
        // Maintenance may wait for this save, but this save never waits on a
        // document lock while already occupying the shared epoch.
        await withRuntimeStorageSharedLock(async () => {
          const existingOutline = existing?.outline as AppDocumentOutline | undefined;
          const outline = data.outline ??
            existingOutline ?? {
              outlines: [],
              createdAt: now,
              updatedAt: now,
            };
          await store.saveDocument({
            stage: {
              ...data.stage,
              id: stageId,
              name: data.stage.name || 'Untitled Stage',
              createdAt: data.stage.createdAt || now,
              updatedAt: now,
            },
            scenes: data.scenes.map((scene, index) => ({
              ...scene,
              stageId,
              order: scene.order ?? index,
              createdAt: scene.createdAt || now,
              updatedAt: scene.updatedAt || now,
            })),
            outline: {
              ...outline,
              createdAt: existingOutline?.createdAt ?? outline.createdAt,
            },
          });
          await saveCurrentScene(stageId, data.currentSceneId);

          // Chat sessions live in the learner RuntimeStore, outside the document DB.
          if (data.chats) {
            try {
              await saveChatSessions(stageId, data.chats, {
                globalLockHeld: true,
                snapshot: data.chatSnapshot,
              });
            } catch (error) {
              const unchangedSnapshot = isEqual(data.chatSnapshot?.sessions ?? [], data.chats);
              if (error instanceof ChatStorageLockUnavailableError && !unchangedSnapshot)
                throw error;
              log.warn(`Document saved but chat sessions failed for stage ${stageId}:`, error);
            }
          }
        });
      },
      { storageSharedLockHeld: true },
    );
    log.info(`Saved stage: ${stageId}`);
  } catch (error) {
    log.error('Failed to save stage:', error);
    throw error;
  }
}

/**
 * Load stage data from IndexedDB
 */
export async function loadStageData(stageId: string): Promise<StageStoreData | null> {
  try {
    const access = await accessDocument(stageId);
    const document = access.document;
    if (!document) {
      log.info(`Stage not found: ${stageId}`);
      return null;
    }
    const currentScene = await loadCurrentScene(stageId);

    // Chat runtime data lives in a separate IndexedDB database. Keep the
    // document available when that independent store is temporarily
    // unavailable; a later chat load/save can recover without treating the
    // already-loaded stage as missing.
    let chats: ChatSession[] = [];
    let chatSnapshot: ChatStorageSnapshot = { sessions: [], restoreMarker: undefined };
    try {
      chats = await loadChatSessions(stageId, {
        onSnapshot: (snapshot) => {
          chatSnapshot = snapshot;
        },
      });
    } catch (error) {
      log.warn(`Failed to load chat sessions for stage ${stageId}:`, error);
    }

    log.info(`Loaded stage: ${stageId}, scenes: ${document.scenes.length}, chats: ${chats.length}`);

    return {
      stage: document.stage,
      scenes: document.scenes,
      currentSceneId:
        currentScene?.sceneId ?? access.legacyCurrentSceneId ?? document.scenes[0]?.id ?? null,
      chats,
      chatSnapshot,
      outline: document.outline as AppDocumentOutline | undefined,
    };
  } catch (error) {
    log.error('Failed to load stage:', error);
    // Corrupt or future-versioned destinations must never masquerade as missing.
    throw error;
  }
}

/**
 * Delete stage and all related data
 */
export async function deleteStageData(stageId: string): Promise<void> {
  // storageSharedLockHeld: the cascade below holds the EXCLUSIVE epoch, which
  // subsumes the shared one — the generation-guarded store must not re-acquire
  // shared inside it (self-deadlock against our own exclusive hold).
  return mutateDocument(
    stageId,
    async (document, store) =>
      // Lock order: per-stage document lock, then the exclusive runtime epoch.
      withRuntimeStorageExclusiveLockUntilSettled(async (releaseCaller) => {
        try {
          // Collect scene ids before deletion so we can sweep per-scene localStorage
          // keys (quiz draft / submitted answers / graded results).
          const legacyScenes = await db.scenes.where('stageId').equals(stageId).toArray();
          const sceneIds = [
            ...new Set([
              ...(document?.scenes.map((s) => s.id) ?? []),
              ...legacyScenes.map((s) => s.id),
            ]),
          ];

          await store.deleteDocument(stageId);

          // Clear legacy chat rows and the device-scoped playback cursor. Runtime
          // rows of every kind are removed by the all-kind cascade below.
          await deleteChatSessions(stageId);
          // An unmigrated legacy playback row must not outlive its stage.
          await db.playbackState.delete(stageId);
          try {
            await clearCursor(stageId);
          } catch (error) {
            log.warn(`Failed to clear playback cursor for stage ${stageId}:`, error);
          }
          try {
            await clearCurrentScene(stageId);
          } catch (error) {
            log.warn(`Failed to clear editor current scene for stage ${stageId}:`, error);
          }

          // Sweep quiz persistence keys for each deleted scene.
          for (const sceneId of sceneIds) {
            clearAllForScene(sceneId);
          }

          // Migration retains legacy rows, but an explicit whole-stage deletion does not.
          await db.transaction('rw', [db.stages, db.scenes, db.stageOutlines], async () => {
            await db.stages.delete(stageId);
            await db.scenes.where('stageId').equals(stageId).delete();
            await db.stageOutlines.delete(stageId);
          });

          // Learner-runtime data lives in a separate IndexedDB database, so it is
          // cascaded after the Dexie work: it cannot join those transactions, and a
          // runtime failure must not abort them (the helper warns instead of
          // throwing).
          const runtimeDeletion = beginStageRuntimeDeletionSafely(stageId);
          await runtimeDeletion.completion;
          try {
            await clearStageDrainWatermarks(stageId);
          } catch (error) {
            log.warn(`Failed to clear PBL drain watermarks for stage ${stageId}:`, error);
          }

          log.info(`Deleted stage: ${stageId}`);
          releaseCaller(undefined);
          // The public deletion remains bounded, but this callback deliberately
          // retains the exclusive lock until a late runtime cascade can no longer
          // delete data written after the caller was released.
          await runtimeDeletion.settlement;
        } catch (error) {
          log.error('Failed to delete stage:', error);
          throw error;
        }
      }),
    { storageSharedLockHeld: true },
  );
}

/**
 * List all stages
 */
export async function listStages(): Promise<StageListItem[]> {
  try {
    const summaries = await getDocumentStore().listDocuments();
    const ids = new Set(summaries.map((summary) => summary.id));
    const legacy = await getLegacyDocumentStore().listStages();
    const legacyOnly = await Promise.all(
      legacy
        .filter((stage) => !ids.has(stage.id))
        .map(async (stage) => {
          const snapshot = await getLegacyDocumentStore().read(stage.id);
          return snapshot ? { ...stage, sceneCount: snapshot.scenes.length } : null;
        }),
    );
    return [
      ...summaries,
      ...legacyOnly
        .filter((stage) => stage !== null)
        .map((stage) => ({
          id: stage.id,
          name: stage.name,
          description: stage.description,
          sceneCount: stage.sceneCount,
          createdAt: stage.createdAt,
          updatedAt: stage.updatedAt,
          interactiveMode: stage.interactiveMode,
          taskEngineMode: stage.taskEngineMode,
        })),
    ].sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    log.error('Failed to list stages:', error);
    return [];
  }
}

type ThumbnailMediaElement = {
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

type ThumbnailSlide = import('@openmaic/dsl').Slide;

function isGeneratedMediaRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_(img|vid)_[\w-]+$/i.test(value);
}

function isLegacySequentialVideoRef(value: unknown): value is string {
  return typeof value === 'string' && /^gen_vid_\d+$/i.test(value);
}

function getThumbnailMediaRef(element: ThumbnailMediaElement): string | undefined {
  if (element.type === 'image' && isGeneratedMediaRef(element.src)) {
    return element.src;
  }
  if (element.type === 'video') {
    if (isGeneratedMediaRef(element.mediaRef)) return element.mediaRef;
    if (isGeneratedMediaRef(element.src)) return element.src;
  }
  return undefined;
}

function getMediaRecordElementId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

function revokeObjectUrl(url: string | undefined) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function revokeThumbnailSlideMediaUrls(slides: Record<string, ThumbnailSlide>) {
  for (const slide of Object.values(slides)) {
    for (const element of slide.elements as ThumbnailMediaElement[]) {
      if (element.type === 'image' || element.type === 'video') {
        revokeObjectUrl(element.src);
      }
      if (element.type === 'video') {
        revokeObjectUrl(element.poster);
      }
    }
  }
}

/**
 * Get first slide scene's canvas data for each stage (for thumbnail preview).
 * Also resolves generated image/video refs from mediaFiles so thumbnails show real media.
 * Returns a map of stageId -> Slide (canvas data with resolved media)
 */
export async function getFirstSlideByStages(
  stageIds: string[],
): Promise<Record<string, ThumbnailSlide>> {
  const result: Record<string, ThumbnailSlide> = {};
  try {
    await Promise.all(
      stageIds.map(async (stageId) => {
        const document = (await accessDocument(stageId)).document;
        const firstSlide = document?.scenes.find((s) => s.content?.type === 'slide');
        if (firstSlide && firstSlide.content.type === 'slide') {
          const slide = structuredClone(firstSlide.content.canvas);

          const mediaElements = slide.elements.filter((el) =>
            getThumbnailMediaRef(el as ThumbnailMediaElement),
          );
          if (mediaElements.length > 0) {
            const mediaRecords = await db.mediaFiles.where('stageId').equals(stageId).toArray();
            const videoRecords = mediaRecords.filter(
              (record) => !record.error && record.type === 'video',
            );
            const mediaMap = new Map(
              mediaRecords.map((record) => [getMediaRecordElementId(record.id), record] as const),
            );

            for (const el of mediaElements as ThumbnailMediaElement[]) {
              const mediaRef = getThumbnailMediaRef(el);
              const exactRecord = mediaRef ? mediaMap.get(mediaRef) : undefined;
              const usableExactRecord = exactRecord && !exactRecord.error ? exactRecord : undefined;
              const legacyRecord =
                !exactRecord &&
                el.type === 'video' &&
                isLegacySequentialVideoRef(mediaRef) &&
                videoRecords.length === 1
                  ? videoRecords[0]
                  : undefined;
              const record = usableExactRecord ?? legacyRecord;

              if (!mediaRef || !record) {
                if (el.type === 'image') {
                  // Clear unresolved placeholder so BaseImageElement won't subscribe
                  // to the global media store (which may have stale data from another course)
                  el.src = '';
                }
                continue;
              }

              if (el.type === 'image' && record.type === 'image') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
              } else if (el.type === 'video' && record.type === 'video') {
                el.src = URL.createObjectURL(blobWithType(record.blob, record.mimeType));
                if (record.poster) {
                  el.poster = URL.createObjectURL(blobWithType(record.poster, 'image/jpeg'));
                }
              } else if (el.type === 'image') {
                el.src = '';
              }
            }
          }

          result[stageId] = slide;
        }
      }),
    );
  } catch (error) {
    log.error('Failed to load thumbnails:', error);
  }
  return result;
}

/**
 * Rename a stage (updates only the name field in IndexedDB)
 */
export async function renameStage(stageId: string, newName: string): Promise<void> {
  try {
    await mutateDocument(stageId, async (document, store) => {
      if (!document) throw new Error(`Stage not found: ${stageId}`);
      await store.putStage(stageId, { ...document.stage, name: newName, updatedAt: Date.now() });
    });
    log.info(`Renamed stage ${stageId} to "${newName}"`);
  } catch (error) {
    log.error('Failed to rename stage:', error);
    throw error;
  }
}

/**
 * Check if stage exists
 */
export async function stageExists(stageId: string): Promise<boolean> {
  try {
    const summaries = await getDocumentStore().listDocuments();
    if (summaries.some((stage) => stage.id === stageId)) return true;
    return (await getLegacyDocumentStore().read(stageId)) !== null;
  } catch (error) {
    log.error('Failed to check stage existence:', error);
    return false;
  }
}
