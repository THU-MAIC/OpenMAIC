/**
 * Stage Storage Manager
 *
 * Saves, loads, lists and deletes courses through the server-backed document
 * store, and manages the owner's folders through the `/api/folders` routes.
 */

import { Stage, Scene } from '../types/stage';
import { ChatSession } from '../types/chat';
import { db } from '@/lib/device-storage/database';
import type { FolderRecord } from '@/lib/types/folder';
import { FolderNameError } from './folder-name-validation';
export { FolderNameError } from './folder-name-validation';
import {
  ChatStorageLockUnavailableError,
  saveChatSessions,
  loadChatSessions,
  type ChatStorageSnapshot,
} from './chat-storage';
import isEqual from 'lodash/isEqual';
import { clearCursor } from '@/lib/playback/cursor';
import {
  accessDocument,
  clearCurrentScene,
  getDocumentStore,
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
import { DocumentVersionError, type DocumentSummary } from '@openmaic/storage';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import {
  MISSING_ASSET_LEASE,
  isConcreteMediaAddress,
  renderableMediaUrl,
  resolveMediaRef,
  type MediaTaskState,
} from '@/lib/media/resolve-media-ref';
import { withAssetUrl } from '@/lib/media/use-asset-url';
import { mayNameAPoolAsset } from '@/lib/media/media-placeholder';
import {
  currentModelCapabilities,
  mediaGenerationDisabled,
} from '@/lib/model-settings/capabilities';
import {
  beginStageDeletionCascade,
  isStageDeleted,
  isStageWriteStale,
  markStageDeleted,
  settleStageDeletionCascade,
  unmarkStageDeleted,
} from './deleted-stages';
import { clearStageMediaCache } from '@/lib/media/clear-stage-media-cache';
import { clearPendingMediaAllocations } from '@/lib/media/pending-media-allocations';
import { applyKnownMediaAllocations } from '@/lib/media/reconcile-scene-media';
import {
  collectDocumentMediaElements,
  resolveMediaTaskForElement,
  resolveVideoMediaForElement,
  type MediaTaskLookupEntry,
} from '@/lib/media/media-task-resolution';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';

const log = createLogger('StageStorage');

/**
 * Dispatched on `window` when something other than the library page changed
 * the owner's courses or folders in the background (the one-way importer of
 * pre-server browser data does), so an open library can list them again.
 */
export const LIBRARY_CHANGED_EVENT = 'openmaic:library-changed';

export interface StageStoreData {
  stage: Stage;
  scenes: Scene[];
  currentSceneId: string | null;
  chats: ChatSession[];
  chatSnapshot?: ChatStorageSnapshot;
  /** The aggregate save contract treats omission as deletion; callers should carry this snapshot. */
  outline?: AppDocumentOutline;
}

/**
 * A logical editor change waiting for persistence. Call sites intentionally
 * describe what changed, not how it is stored, so a future operation-log
 * backend can replace the flush implementation without changing mutations.
 */
export type PendingChange =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'structure' }
  | { kind: 'stage' }
  | { kind: 'outline' }
  | { kind: 'currentScene' }
  | { kind: 'chats' };

export interface StageListItem {
  id: string;
  name: string;
  description?: string;
  sceneCount: number;
  createdAt: number;
  updatedAt: number;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
  /** Folder this course belongs to; undefined = unfiled. Device-local only. */
  folderId?: string;
}

function stampStage(stageId: string, stage: Stage, now: number): Stage {
  return {
    ...stage,
    id: stageId,
    name: stage.name || 'Untitled Stage',
    createdAt: stage.createdAt || now,
    updatedAt: now,
  };
}

function stampScene(stageId: string, scene: Scene, index: number, now: number): Scene {
  return {
    ...scene,
    stageId,
    order: scene.order ?? index,
    createdAt: scene.createdAt || now,
    updatedAt: scene.updatedAt || now,
  };
}

function documentSnapshot(
  stageId: string,
  data: StageStoreData,
  existingOutline: AppDocumentOutline | undefined,
  now: number,
) {
  // The browser's outline carries the plan and its completion; what a
  // producer recorded beside them (`producer`, `producerRef`, receipts) stays,
  // so a course a generation run produced is still known as the run's.
  const outline = (data.outline ? { ...existingOutline, ...data.outline } : undefined) ??
    existingOutline ?? {
      outlines: [],
      createdAt: now,
      updatedAt: now,
    };
  return {
    stage: stampStage(stageId, data.stage, now),
    scenes: data.scenes.map((scene, index) => stampScene(stageId, scene, index, now)),
    outline: {
      ...outline,
      createdAt: existingOutline?.createdAt ?? outline.createdAt,
    },
  };
}

async function saveStageChats(
  stageId: string,
  data: StageStoreData,
  globalLockHeld = false,
): Promise<boolean> {
  try {
    await saveChatSessions(stageId, data.chats, {
      ...(globalLockHeld ? { globalLockHeld: true } : {}),
      snapshot: data.chatSnapshot,
    });
    return true;
  } catch (error) {
    const unchangedSnapshot = isEqual(data.chatSnapshot?.sessions ?? [], data.chats);
    if (error instanceof ChatStorageLockUnavailableError && !unchangedSnapshot) throw error;
    log.warn(`Chat sessions failed to save for stage ${stageId}:`, error);
    return false;
  }
}

/**
 * A save that was dropped by the deletion-epoch fence. Distinguishable from
 * every success shape on purpose: nothing durable survives — at most some of
 * the writes landed before the fence tripped, and those are removed by the
 * deletion cascade or ignored by the load path (a tail `saveCurrentScene` can
 * land after the cascade's `clearCurrentScene`, but the orphaned cursor row
 * is never exposed: `loadStageData` bails before reading it while the
 * document is missing, and validates it against the document's scenes once
 * one exists again). Callers must not perform success bookkeeping — no
 * snapshot rebinding, no pending clearing, no durability claims.
 */
export type StaleDroppedSave = 'stale-dropped';

/**
 * The one place every durable write passes through.
 *
 * A snapshot reaches storage from several producers — the debounced autosave,
 * the aggregate save, the departing-course flush, an editor-history entry
 * replayed by undo — and each captures content at its own moment. Any of those
 * moments can predate a media write-back, in which case the snapshot still
 * carries a generation placeholder the document has already moved past, and
 * writing it would silently undo a successful rewrite. Rewriting here, rather
 * than at each producer, is what keeps the next producer from rediscovering the
 * same bug. Inert outside server-backed persistence, and a no-op allocation for
 * a snapshot that holds no stale placeholder.
 */
function withKnownMediaAllocations(stageId: string, data: StageStoreData): StageStoreData {
  const applied = applyKnownMediaAllocations(stageId, data.stage, data.scenes);
  if (!applied) return data;
  return { ...data, stage: applied.stage as StageStoreData['stage'], scenes: [...applied.scenes] };
}

/**
 * Save stage data to IndexedDB.
 *
 * `capturedEpoch` is the stage's deletion epoch at the moment `data` was
 * captured — required, so the type system enforces that the capture point and
 * the validation point stay paired. Every write below is fenced by
 * `isStageWriteStale`: it drops when a deletion is in effect OR a deletion
 * happened after the capture — a pre-delete snapshot stays fenced even after
 * a same-id restore lifts the deleted flag, because the restore never rewinds
 * the epoch. A fenced write returns `'stale-dropped'` instead of a success
 * shape.
 */
export async function saveStageData(
  stageId: string,
  data: StageStoreData,
  capturedEpoch: number,
): Promise<{ failedChanges: PendingChange[] } | StaleDroppedSave | undefined> {
  if (isStageWriteStale(stageId, capturedEpoch)) {
    log.info(`Dropping save for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  try {
    const now = Date.now();
    const failedChanges: PendingChange[] = [];
    let dropped = false;
    await mutateDocument(
      stageId,
      async (existing, store) => {
        // Reconciled here, under the document lock, not before it: a write-back
        // running when this save was queued may only have recorded its
        // allocation while we waited for the lock, and a departing-course flush
        // gets no corrective pass afterwards.
        data = withKnownMediaAllocations(stageId, data);
        // Re-check inside the mutation: a deletion that started while this
        // save was waiting must win. With Web Locks this runs under the
        // per-stage document lock; without them the callback is lock-free
        // best-effort LWW, so additional re-checks sit immediately before
        // each write below to shrink the check-then-act window.
        if (isStageWriteStale(stageId, capturedEpoch)) {
          dropped = true;
          return;
        }
        // Lock order: per-stage document lock, then the global runtime epoch.
        // Maintenance may wait for this save, but this save never waits on a
        // document lock while already occupying the shared epoch.
        await withRuntimeStorageSharedLock(async () => {
          const existingOutline = existing?.outline as AppDocumentOutline | undefined;
          if (isStageWriteStale(stageId, capturedEpoch)) {
            dropped = true;
            return;
          }
          await store.saveDocument(documentSnapshot(stageId, data, existingOutline, now));
          if (isStageWriteStale(stageId, capturedEpoch)) {
            dropped = true;
            return;
          }
          await saveCurrentScene(stageId, data.currentSceneId);

          // Chat sessions live in the learner RuntimeStore, outside the document DB.
          if (isStageWriteStale(stageId, capturedEpoch)) {
            dropped = true;
            return;
          }
          if (data.chats && !(await saveStageChats(stageId, data, true))) {
            failedChanges.push({ kind: 'chats' });
          }
        });
      },
      { storageSharedLockHeld: true },
    );
    if (dropped) {
      log.info(`Dropped save mid-write for deleted/stale stage: ${stageId}`);
      return 'stale-dropped';
    }
    log.info(`Saved stage: ${stageId}`);
    return failedChanges.length > 0 ? { failedChanges } : undefined;
  } catch (error) {
    log.error('Failed to save stage:', error);
    throw error;
  }
}

/**
 * Persist only the logical units dirtied by the editor. Structural and outline
 * changes still use the aggregate contract: structure must reconcile scene
 * membership/order, while DocumentStore does not yet expose putOutline.
 */
export async function saveStageDataIncremental(
  stageId: string,
  dirty: readonly PendingChange[],
  data: StageStoreData,
  capturedEpoch: number,
): Promise<{ failedChanges: PendingChange[] } | StaleDroppedSave> {
  // `capturedEpoch` = the deletion epoch when `data` was captured (the flush
  // round / departing-stage snapshot); required so the capture point and the
  // validation point stay paired. See saveStageData for the fencing contract;
  // a stale capture is dropped even after a same-id restore, and a dropped
  // write reports `'stale-dropped'` instead of a success shape.
  if (isStageWriteStale(stageId, capturedEpoch)) {
    log.info(`Dropping incremental save for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  const has = (kind: PendingChange['kind']) => dirty.some((change) => change.kind === kind);
  const dirtySceneIds = new Set(
    dirty.flatMap((change) => (change.kind === 'scene' ? [change.sceneId] : [])),
  );
  const needsDocumentWrite =
    dirtySceneIds.size > 0 || has('structure') || has('stage') || has('outline');
  const documentCategories = new Set(
    dirty.flatMap((change) =>
      change.kind === 'scene' ||
      change.kind === 'structure' ||
      change.kind === 'stage' ||
      change.kind === 'outline'
        ? [change.kind]
        : [],
    ),
  );

  let dropped = false;
  if (needsDocumentWrite) {
    await mutateDocument(
      stageId,
      async (existing, store) => {
        // Reconciled under the lock, for the reason saveStageData gives.
        data = withKnownMediaAllocations(stageId, data);
        // Re-check inside the mutation: `existing === undefined` after a
        // deletion must not be mistaken for a legacy destination — the
        // full-save fallback below would otherwise rebuild the deleted
        // document whole. With Web Locks this runs under the per-stage
        // document lock; without them the callback is lock-free best-effort
        // LWW, so each write below re-checks immediately before landing.
        // Epoch staleness also covers the delete→restore straddle: a round
        // captured pre-delete stays fenced after the restore lifts the flag.
        if (isStageWriteStale(stageId, capturedEpoch)) {
          dropped = true;
          return;
        }
        await withRuntimeStorageSharedLock(async () => {
          const now = Date.now();
          const fullSave = async () => {
            if (isStageWriteStale(stageId, capturedEpoch)) {
              dropped = true;
              return;
            }
            const persistedScenes = await preparePBLScenesForDocumentPersistence(
              stageId,
              data.scenes,
            );
            // Preparation awaited: last re-check immediately before the write.
            if (isStageWriteStale(stageId, capturedEpoch)) {
              dropped = true;
              return;
            }
            await store.saveDocument(
              documentSnapshot(
                stageId,
                { ...data, scenes: persistedScenes },
                existing?.outline as AppDocumentOutline | undefined,
                now,
              ),
            );
          };

          // The incremental fast path is deliberately homogeneous. Combining
          // scene and stage writes would span separate requests/transactions,
          // exposing a torn document to concurrent readers. Structure and
          // outline already require the aggregate contract, and any batch with
          // more than one document category follows that same atomic path.
          if (!existing || has('structure') || has('outline') || documentCategories.size > 1) {
            await fullSave();
            return;
          }

          try {
            if (dirtySceneIds.size > 0) {
              const dirtyScenes = data.scenes.filter((scene) => dirtySceneIds.has(scene.id));
              // Preparation synchronizes and strips each PBL scene independently;
              // it has no sibling-scene dependency, so the hot path stays local.
              const persistedScenes = await preparePBLScenesForDocumentPersistence(
                stageId,
                dirtyScenes,
              );
              for (const scene of persistedScenes) {
                const index = data.scenes.findIndex((candidate) => candidate.id === scene.id);
                // Preparation and prior iterations awaited: re-check before
                // each row write (lock-free environments have no lock to win).
                if (isStageWriteStale(stageId, capturedEpoch)) {
                  dropped = true;
                  return;
                }
                await store.putScene(stageId, stampScene(stageId, scene, index, now));
              }
            }
            if (has('stage')) {
              if (isStageWriteStale(stageId, capturedEpoch)) {
                dropped = true;
                return;
              }
              await store.putStage(stageId, stampStage(stageId, data.stage, now));
            }
          } catch (error) {
            // Incremental APIs reject pre-versioned destinations. The aggregate
            // save migrates/stamps the whole document coherently.
            if (error instanceof DocumentVersionError && error.kind === 'not-current') {
              await fullSave();
              return;
            }
            throw error;
          }
        });
      },
      { storageSharedLockHeld: true },
    );
  }

  // A document-write drop fences the whole flush: once a deletion turned this
  // capture stale, staleness is permanent (the epoch never rewinds), so the
  // tail must not even be attempted.
  if (dropped) {
    log.info(`Dropped incremental save mid-write for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  // Tail writes live outside the document mutation. A delete that won the
  // race above (dropping the document write) must also fence the
  // currentScene KV row and the chat sessions, or this same flush would
  // resurrect rows the deletion cascade just cleared — mirroring the
  // aggregate path, which keeps both inside the guarded callback. Each tail
  // write re-checks independently: a delete can land while the previous tail
  // write is awaiting (there is no lock spanning the tail).
  if (isStageWriteStale(stageId, capturedEpoch)) {
    log.info(`Dropping incremental save tail for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  if (has('currentScene')) await saveCurrentScene(stageId, data.currentSceneId);
  // `saveCurrentScene` awaited: re-check immediately before the chat write.
  if (isStageWriteStale(stageId, capturedEpoch)) {
    log.info(`Dropping incremental chat tail for deleted/stale stage: ${stageId}`);
    return 'stale-dropped';
  }
  const failedChanges: PendingChange[] = [];
  if (has('chats') && !(await saveStageChats(stageId, data))) {
    failedChanges.push({ kind: 'chats' });
  }
  return { failedChanges };
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

    // Deliberate defense-in-depth: persisted cursors can outlive scene deletion
    // or come from legacy storage, so never expose one absent from the document.
    const storedCursor = currentScene?.sceneId ?? access.legacyCurrentSceneId;
    const currentSceneId =
      storedCursor && document.scenes.some((scene) => scene.id === storedCursor)
        ? storedCursor
        : (document.scenes[0]?.id ?? null);

    return {
      stage: document.stage,
      scenes: document.scenes,
      currentSceneId,
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
 * In-flight deletions, keyed by stage id. `deleteStageData` is single-flight
 * per stage: a concurrent second call joins the first cascade instead of
 * starting an overlapping one, so begin/settle pairs for one stage never
 * interleave and a settling cascade cannot expose another one's keep-window
 * (the warm-ghost retention in `loadFromStorage`) as already settled.
 */
const inFlightStageDeletions = new Map<string, Promise<void>>();

/**
 * Delete stage and all related data. Single-flight per stage: concurrent
 * calls for the same id share one cascade (and its outcome).
 *
 * A joined call carries its own deletion intent, not just an interest in the
 * first cascade's outcome. If a same-id restore (server copy, backup import)
 * recreates the document while the first cascade runs, that cascade's success
 * describes the PRE-restore document — reporting it as-is would tell the
 * joined caller "deleted" while the restored document survives. So when the
 * first cascade fulfills but the stage is no longer marked deleted at join
 * resolution, one fresh cascade runs for the restored document and the joined
 * caller reports THAT outcome. Exactly one re-check per call, not a loop: if
 * yet another restore lands inside the re-run's own window, the re-run's
 * outcome is returned as-is — every later delete is a new `deleteStageData`
 * call with its own re-check, so repeated restore/delete races converge on
 * fresh calls instead of recursing here. A REJECTED first cascade propagates
 * unchanged to every joined caller even though failure also leaves the stage
 * unmarked: failure already reports "nothing was deleted" truthfully (and the
 * pending-dirt restore has run), and re-running would turn an error report
 * into a hidden retry.
 */
export function deleteStageData(stageId: string): Promise<void> {
  const existing = inFlightStageDeletions.get(stageId);
  if (!existing) return runSingleFlightStageDeletion(stageId);
  return existing.then(() => {
    if (isStageDeleted(stageId)) return;
    // Restored mid-cascade: the joined intent targets the restored document.
    // If several joined callers re-check in the same resolution turn, the
    // first re-run's map entry is already visible to the rest, so they join
    // it below rather than fanning out into parallel cascades.
    return runSingleFlightStageDeletion(stageId);
  });
}

function runSingleFlightStageDeletion(stageId: string): Promise<void> {
  const existing = inFlightStageDeletions.get(stageId);
  if (existing) return existing;
  const run = performStageDeletion(stageId).finally(() => {
    inFlightStageDeletions.delete(stageId);
  });
  inFlightStageDeletions.set(stageId, run);
  return run;
}

async function performStageDeletion(stageId: string): Promise<void> {
  // Dynamic import avoids a static module cycle with the store.
  const {
    clearStoreForDeletedStage,
    discardPendingStageChanges,
    restorePendingStageChanges,
    snapshotPendingStageChangesForDeletion,
  } = await import('@/lib/store/stage');
  // Snapshot the dirt this deletion is about to discard (queued + in-flight)
  // BEFORE the deletion is marked, so a deletion that fails while the
  // document still exists can put those PRE-DELETE edits back on the retry
  // path instead of leaving them silently non-durable in memory. The
  // snapshot covers scheduler-tracked dirt only; content that never had a
  // descriptor — a direct aggregate save (`saveToStorage`) the epoch fence
  // drops mid-flight, or edits refused during the deletion window — is
  // recovered by the restore's full-aggregate re-mark instead (see
  // restorePendingStageChanges).
  const discardedChanges = snapshotPendingStageChangesForDeletion(stageId);
  // Mark the deletion next: this bumps the stage's deletion epoch, so every
  // persistence landing point drops writes captured before this moment —
  // even a flush round that already holds its dirty snapshot (or the
  // departing-stage retry), and even if a same-id restore later lifts the
  // deleted flag.
  markStageDeleted(stageId);
  // The cascade's outcome is unknown until it settles. Read-side consumers
  // (the deleted-warm branch in loadFromStorage) must not treat the deleted
  // flag as "document gone" while this holds — a failure before document
  // removal lifts the flag and hands the pending dirt back — so they await
  // stageDeletionSettled instead. That wait cannot deadlock against this
  // cascade: the cascade never waits on a load, and a parked load holds no
  // document lock while awaiting settlement.
  beginStageDeletionCascade(stageId);
  // Then drop any still-queued persistence work for this stage: a mutation
  // sitting in the debounce window must not even start a flush after the
  // delete.
  discardPendingStageChanges(stageId);
  // Media allocations parked for slides this stage will never build now have
  // no possible destination. Their bytes are the server's to expire: an
  // allocation no document ever commits is released once its pending TTL runs
  // out, so dropping the record here loses nothing but the record.
  clearPendingMediaAllocations(stageId);
  let documentDeleted = false;
  try {
    // storageSharedLockHeld: the cascade below holds the EXCLUSIVE epoch, which
    // subsumes the shared one — the generation-guarded store must not re-acquire
    // shared inside it (self-deadlock against our own exclusive hold).
    await mutateDocument(
      stageId,
      async (document, store) =>
        // Lock order: per-stage document lock, then the exclusive runtime epoch.
        withRuntimeStorageExclusiveLockUntilSettled(async (releaseCaller) => {
          try {
            // Collect scene ids before deletion so we can sweep per-scene localStorage
            // keys (quiz draft / submitted answers / graded results).
            const sceneIds = [...new Set(document?.scenes.map((s) => s.id) ?? [])];

            await store.deleteDocument(stageId);
            documentDeleted = true;

            // Local cache only, and intentionally after the authoritative
            // delete: liveness for the globally keyed audio rows is proved
            // against the documents that survive, which requires this one to
            // already be gone. The registry entries the document named are
            // released by the server's own pass once the grace elapses.
            await clearStageMediaCache(stageId);

            // Clear the device-scoped playback cursor. Runtime rows of every
            // kind are removed by the all-kind cascade below.
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

            // Learner-runtime data is a separate store, so it is cascaded after
            // the document: a runtime failure must not undo the deletion (the
            // helper warns instead of throwing).
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
  } catch (error) {
    // If the deletion failed before the document was removed, the stage still
    // exists — lift the deleted flag so subsequent edits persist normally,
    // and put the discarded dirt back on the retry path (it was only dropped
    // to prevent a resurrection that now cannot happen). The restore also
    // re-marks the FULL aggregate: an in-flight direct aggregate save this
    // deletion fenced has no descriptor in the snapshot, and only a flush
    // that recaptures the whole current store state can carry its content to
    // disk. The deletion epoch
    // stays bumped, which is safe for the restored dirt: restore re-QUEUES
    // change descriptors, so the eventual flush captures a fresh snapshot of
    // the CURRENT store state under the CURRENT epoch — it does not replay
    // the pre-delete capture, so nothing it writes can be epoch-stale. Once
    // the document is gone, the deleted flag stays even on a partial cascade
    // failure: dropping later writes is exactly what prevents resurrection.
    if (!documentDeleted) {
      unmarkStageDeleted(stageId);
      restorePendingStageChanges(stageId, discardedChanges);
    }
    throw error;
  } finally {
    // Settlement: whichever way the cascade ended, its outcome is now
    // recorded — document removed (deleted flag kept) or deletion failed
    // before removal (flag lifted above). The read side may act on the flag.
    settleStageDeletionCascade(stageId);
  }
  // Success: evict the deleted classroom from the in-memory store. A warm
  // store would otherwise keep rendering the deleted classroom from memory —
  // loadFromStorage short-circuits on it, the server-restore path never runs,
  // and every edit is silently dropped. Done here (not at the UI call site)
  // because this module already owns the deletion cascade's store-side
  // bookkeeping through the same dynamic-import seam, so every caller of
  // deleteStageData gets the invariant, not just the home page.
  //
  // Ordering with settlement waiters: the settle above releases any load
  // parked in loadFromStorage's mid-deletion branch, but that waiter resumes
  // as a microtask — this synchronous eviction runs first. The eviction
  // deliberately keeps the current load token (see clearStoreForDeletedStage)
  // so that resumed load stays current and performs the cold reload that
  // hands the emptied route to the server-restore path.
  clearStoreForDeletedStage(stageId);
}

/**
 * List the owner's courses, newest first.
 *
 * The generic `GET /api/persistence/documents` listing is deliberately refused
 * server-side (`403 FORBIDDEN_DOCUMENTS`): the capability model serves reads by
 * id and listings owner-only, so the course list must not ask for an unscoped
 * listing at all. `GET /api/stages` IS the owner listing — it resolves the
 * owner from the same cookie the workbench uses and returns that owner's stage
 * documents, each with the folder it is filed in.
 */
export async function listStages(): Promise<StageListItem[]> {
  try {
    const res = await fetch('/api/stages', { credentials: 'include' });
    if (!res.ok) {
      throw new Error(`Failed to list owner stages: HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { stages?: unknown } | null;
    if (!body || !Array.isArray(body.stages)) {
      throw new Error('Malformed /api/stages response: expected { stages: [...] }');
    }
    return (body.stages as DocumentSummary[])
      .map((item) => {
        const base: StageListItem = {
          id: item.id,
          name: item.name,
          sceneCount: item.sceneCount,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          ...(item.description !== undefined ? { description: item.description } : {}),
          ...(item.interactiveMode !== undefined ? { interactiveMode: item.interactiveMode } : {}),
          ...(item.taskEngineMode !== undefined ? { taskEngineMode: item.taskEngineMode } : {}),
        };
        return item.folderId ? { ...base, folderId: item.folderId } : base;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    log.error('Failed to list stages:', error);
    throw error;
  }
}

type ThumbnailMediaElement = {
  id: string;
  type: string;
  src?: string;
  mediaRef?: string;
  poster?: string;
};

type ThumbnailSlide = import('@openmaic/dsl').Slide;

function isResolvableThumbnailMediaRef(value: unknown): value is string {
  return typeof value === 'string' && !!value && !isConcreteMediaAddress(value);
}

function getThumbnailMediaRef(element: ThumbnailMediaElement): string | undefined {
  if (element.type === 'image' && isResolvableThumbnailMediaRef(element.src)) {
    return element.src;
  }
  return undefined;
}

function getMediaRecordElementId(recordId: string): string {
  return recordId.includes(':') ? recordId.split(':').slice(1).join(':') : recordId;
}

function blobWithType(blob: Blob, mimeType: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeType });
}

export async function resolveThumbnailMediaValue(
  ref: string,
  task: MediaTaskState | undefined,
  storedBlob: Blob | undefined,
  mimeType: string,
  mediaGenerationDisabled = false,
): Promise<string | undefined> {
  if (isConcreteMediaAddress(ref)) {
    return renderableMediaUrl(resolveMediaRef(ref, undefined, MISSING_ASSET_LEASE));
  }
  let blob: Blob | undefined;
  try {
    // A generation placeholder is not a pool id: leasing it is a guaranteed
    // miss, and a thumbnail grid asks once per slide per load.
    blob = mayNameAPoolAsset(ref)
      ? await withAssetUrl(ref, async (url) => {
          if (!url) return undefined;
          const response = await fetch(url);
          const fetched = response.ok ? await response.blob() : undefined;
          // Zero-byte pool answers are not usable bytes: fall back to the
          // stored row (or no thumbnail) rather than minting an empty image.
          return fetched && fetched.size > 0 ? fetched : undefined;
        })
      : undefined;
  } catch {
    // Pool access is optional for the home-page compatibility thumbnail.
  }
  blob ??= storedBlob && storedBlob.size > 0 ? blobWithType(storedBlob, mimeType) : undefined;
  if (blob) {
    const url = URL.createObjectURL(blobWithType(blob, mimeType));
    return renderableMediaUrl(
      resolveMediaRef(ref, task, { status: 'resolved', url }, mediaGenerationDisabled),
    );
  }
  return renderableMediaUrl(
    resolveMediaRef(ref, task, MISSING_ASSET_LEASE, mediaGenerationDisabled),
  );
}

function revokeObjectUrl(url: string | undefined) {
  if (url?.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export function revokeThumbnailSlideMediaUrls(slides: Record<string, ThumbnailSlide>) {
  for (const slide of Object.values(slides)) {
    for (const slot of slideMediaReferenceSlots(slide)) {
      if (slot.kind !== 'video-media-ref') revokeObjectUrl(slot.read());
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

          const mediaSlots = [...slideMediaReferenceSlots(slide)];
          const mediaElements = new Set<ThumbnailMediaElement>();
          for (const slot of mediaSlots) {
            if (
              slot.element &&
              (slot.element.type === 'video' ||
                !!getThumbnailMediaRef(slot.element as ThumbnailMediaElement))
            ) {
              mediaElements.add(slot.element as ThumbnailMediaElement);
            }
          }
          const backgroundSlot = mediaSlots.find((slot) => slot.kind === 'background-image');
          const backgroundRef = backgroundSlot?.read();
          if (
            mediaElements.size > 0 ||
            (backgroundRef && isResolvableThumbnailMediaRef(backgroundRef))
          ) {
            const capabilities = currentModelCapabilities();
            const imageDisabled = mediaGenerationDisabled(capabilities, 'image');
            const videoDisabled = mediaGenerationDisabled(capabilities, 'video');
            const mediaRecords = await db.mediaFiles.where('stageId').equals(stageId).toArray();
            const mediaMap = new Map(
              mediaRecords.map((record) => [getMediaRecordElementId(record.id), record] as const),
            );
            type ThumbnailTaskEntry = MediaTaskLookupEntry & {
              readonly record: (typeof mediaRecords)[number];
            };
            const taskEntries = Object.fromEntries(
              mediaRecords.map((record) => [
                getMediaRecordElementId(record.id),
                {
                  stageId: record.stageId,
                  type: record.type,
                  status: record.error ? 'failed' : 'done',
                  placeholderRef: record.placeholderRef,
                  poster: record.poster ? `${record.id}:poster` : undefined,
                  record,
                } satisfies ThumbnailTaskEntry,
              ]),
            );
            const documentElements = collectDocumentMediaElements(
              document?.stage,
              document?.scenes ?? [],
            );

            if (backgroundSlot && backgroundRef && isResolvableThumbnailMediaRef(backgroundRef)) {
              const selectedRecord = mediaMap.get(backgroundRef);
              const task = selectedRecord?.error
                ? ({
                    status: 'failed',
                    errorCode: selectedRecord.errorCode,
                    retryCount: 0,
                  } satisfies MediaTaskState)
                : undefined;
              const record = selectedRecord && !selectedRecord.error ? selectedRecord : undefined;
              backgroundSlot.write(
                (await resolveThumbnailMediaValue(
                  backgroundRef,
                  task,
                  record?.type === 'image' ? record.blob : undefined,
                  record?.mimeType || 'image/png',
                  imageDisabled,
                )) ?? '',
              );
            }

            for (const el of mediaElements) {
              const videoBinding =
                el.type === 'video'
                  ? resolveVideoMediaForElement(
                      taskEntries,
                      el as import('@openmaic/dsl').PPTVideoElement,
                      stageId,
                      documentElements,
                    )
                  : undefined;
              const mediaRef = videoBinding?.sourceRef ?? getThumbnailMediaRef(el);
              if (!mediaRef) continue;
              const selected =
                el.type === 'video'
                  ? videoBinding?.task
                  : resolveMediaTaskForElement(
                      taskEntries,
                      el as import('@openmaic/dsl').PPTElement,
                      stageId,
                    );
              const selectedRecord = selected?.record;
              const task = selectedRecord?.error
                ? ({
                    status: 'failed',
                    errorCode: selectedRecord.errorCode,
                    retryCount: 0,
                  } satisfies MediaTaskState)
                : undefined;
              const record = selectedRecord && !selectedRecord.error ? selectedRecord : undefined;

              if (el.type === 'image') {
                el.src =
                  (await resolveThumbnailMediaValue(
                    mediaRef,
                    task,
                    record?.type === 'image' ? record.blob : undefined,
                    record?.mimeType || 'image/png',
                    imageDisabled,
                  )) ?? '';
              } else if (el.type === 'video') {
                el.src =
                  (await resolveThumbnailMediaValue(
                    mediaRef,
                    task,
                    record?.type === 'video' ? record.blob : undefined,
                    record?.mimeType || 'video/mp4',
                    videoDisabled,
                  )) ?? '';
                const posterRef = videoBinding?.posterRef;
                const posterRecord =
                  posterRef && isResolvableThumbnailMediaRef(posterRef)
                    ? mediaMap.get(posterRef)
                    : undefined;
                const posterBlob =
                  posterRecord && !posterRecord.error && posterRecord.type === 'image'
                    ? blobWithType(posterRecord.blob, posterRecord.mimeType)
                    : record?.poster
                      ? blobWithType(record.poster, 'image/jpeg')
                      : undefined;
                if (posterRef) {
                  const posterTask = posterRecord?.error
                    ? ({
                        status: 'failed',
                        errorCode: posterRecord.errorCode,
                        retryCount: 0,
                      } satisfies MediaTaskState)
                    : undefined;
                  el.poster = await resolveThumbnailMediaValue(
                    posterRef,
                    posterTask,
                    posterBlob,
                    posterRecord?.mimeType || 'image/jpeg',
                  );
                } else if (posterBlob) {
                  el.poster = URL.createObjectURL(posterBlob);
                }
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
    return (await getDocumentStore().loadDocument(stageId)) !== null;
  } catch (error) {
    log.error('Failed to check stage existence:', error);
    return false;
  }
}

// ==================== Course Folders ====================
//
// Folders are course-grouping metadata owned by the same owner as the courses.
// The list and every folder mutation go through the owner-scoped
// `/api/folders` routes — the same store the workspace rail and the agent's
// `create_folder` tool write to — and membership through
// `/api/folders/members`. A course with no membership is unfiled.

/** The wire shape of the owner-scoped folder routes (`/api/folders`). */
type FolderRouteBody = {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly folder?: FolderRecord;
  readonly folders?: readonly FolderRecord[];
  readonly removedStageIds?: readonly string[];
};

/**
 * Map a route refusal (`{ error: { code, message } }`) onto the shared
 * `FolderNameError`, so every dialog maps one error type.
 */
function folderRouteError(body: FolderRouteBody | null | undefined): Error {
  const code = body?.error?.code;
  const message = typeof body?.error?.message === 'string' ? body.error.message : undefined;
  if (code === 'FOLDER_NAME_DUPLICATE') {
    return new FolderNameError(message ?? 'A folder with this name already exists', 'duplicate');
  }
  if (code === 'FOLDER_NAME_TOO_LONG') {
    return new FolderNameError(message ?? 'Folder name is too long', 'tooLong');
  }
  if (code === 'FOLDER_NAME_EMPTY') {
    return new FolderNameError(message ?? 'Folder name must not be empty', 'empty');
  }
  if (code === 'FOLDER_LIMIT_REACHED') {
    return new FolderNameError(message ?? 'Folder count limit reached', 'limit');
  }
  return new Error(message ?? 'folder request failed');
}

/** The owner-scoped routes return the reference's `FolderItem` (row + userKey). */
function toFolderRecord(folder: FolderRecord): FolderRecord {
  return {
    id: folder.id,
    name: folder.name,
    order: folder.order,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

/**
 * List the owner's folders, ordered by their `order` field (ascending).
 */
export async function listFolders(): Promise<FolderRecord[]> {
  const res = await fetch('/api/folders', { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to list owner folders: HTTP ${res.status}`);
  }
  const body = (await res.json().catch(() => null)) as FolderRouteBody | null;
  if (!body || !Array.isArray(body.folders)) {
    throw new Error('Malformed /api/folders response: expected { folders: [...] }');
  }
  return body.folders.map(toFolderRecord);
}

/**
 * Create a folder. The route validates the name (width + uniqueness) and the
 * count limit inside its owner-scoped transaction; its refusals map onto
 * `FolderNameError`.
 */
export async function createFolder(name: string): Promise<FolderRecord> {
  const res = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => null)) as FolderRouteBody | null;
  if (!res.ok) throw folderRouteError(body);
  if (!body?.folder) {
    throw new Error('Malformed /api/folders response: expected { folder: { ... } }');
  }
  log.info(`Created folder "${name}" (${body.folder.id})`);
  return toFolderRecord(body.folder);
}

/** Rename a folder (`PATCH /api/folders/:id`); refusals map onto `FolderNameError`. */
export async function renameFolder(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw folderRouteError((await res.json().catch(() => null)) as FolderRouteBody | null);
  }
  log.info(`Renamed folder ${id} to "${name}"`);
}

export type DeleteFolderMode = 'ungroup' | 'remove';

/**
 * Delete a folder (`DELETE /api/folders/:id`).
 *
 * - `'ungroup'` (default): drop the folder; its courses become unfiled.
 * - `'remove'`: drop the folder AND delete every course that was filed in it.
 *   The route returns the captured member ids, and each runs through
 *   {@link deleteStageData} so the full deletion cascade (document, runtime,
 *   device-local caches) applies.
 */
export async function deleteFolder(id: string, mode: DeleteFolderMode = 'ungroup'): Promise<void> {
  const res = await fetch(`/api/folders/${encodeURIComponent(id)}?mode=${mode}`, {
    method: 'DELETE',
  });
  const body = (await res.json().catch(() => null)) as FolderRouteBody | null;
  if (!res.ok) throw folderRouteError(body);
  if (mode === 'remove') {
    const removedStageIds = body?.removedStageIds ?? [];
    await Promise.all(removedStageIds.map((stageId) => deleteStageData(stageId)));
  }
  log.info(`Deleted folder ${id} (mode=${mode})`);
}

/**
 * Move a course into a folder, or out of all folders when `folderId` is
 * `undefined` (`POST /api/folders/members`). Idempotent. The route checks that
 * the folder exists and belongs to the owner; a missing folder is refused.
 */
export async function setStageFolder(stageId: string, folderId: string | undefined): Promise<void> {
  const res = await fetch('/api/folders/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stageId, folderId: folderId ?? null }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as FolderRouteBody | null;
    if (body?.error?.code === 'FOLDER_NOT_FOUND') {
      throw new Error(`Folder not found: ${folderId}`);
    }
    throw folderRouteError(body);
  }
  log.info(`Set stage ${stageId} folder -> ${folderId ?? '(unfiled)'}`);
}
