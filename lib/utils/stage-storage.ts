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
import { DocumentVersionError } from '@openmaic/storage';
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import {
  beginStageDeletionCascade,
  isStageDeleted,
  isStageWriteStale,
  markStageDeleted,
  settleStageDeletionCascade,
  unmarkStageDeleted,
} from './deleted-stages';

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
  const outline = data.outline ??
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
            const legacyScenes = await db.scenes.where('stageId').equals(stageId).toArray();
            const sceneIds = [
              ...new Set([
                ...(document?.scenes.map((s) => s.id) ?? []),
                ...legacyScenes.map((s) => s.id),
              ]),
            ];

            await store.deleteDocument(stageId);
            documentDeleted = true;

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

            // Mirror hygiene: the legacy roster mirror is read-only migration
            // input, but a deleted stage needs no migration source — drop its
            // rows. Best-effort: a failure here must not abort the deletion.
            try {
              await db.generatedAgents.where('stageId').equals(stageId).delete();
            } catch (error) {
              log.warn(`Failed to clear legacy agent mirror rows for stage ${stageId}:`, error);
            }

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
    throw error;
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
