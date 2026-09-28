/**
 * One legacy course, moved to the server step by step.
 *
 * Where it goes (decided once, then kept in the ledger):
 *
 * - This owner already has the course id on the server (an earlier opt-in
 *   server build synced it): the server copy is authoritative. Nothing of it
 *   is overwritten; only media bytes that exist solely in this browser are
 *   uploaded, device-only rows are copied, and a course the server has
 *   unfiled is filed in its old folder. Origin `existing`.
 * - The id is free: the course is created under its own id. Origin `created`.
 * - Another owner holds the id (ids are global, and anything readable by id
 *   that this owner does not list is someone else's): the course is created
 *   under a fresh id derived from the owner and the legacy id, and every
 *   internal reference that carries the course id moves with it -- scene
 *   stage ids, runtime session and record ids, the playback and editor
 *   positions, folder membership. Origin `created`.
 * - This owner deleted the course on the server (a write answers 404 for a
 *   tombstoned id): the deletion stands. Skipped.
 *
 * A created course then gets, in order: media bytes, learner runtime, the old
 * chat table, the playback position, pre-runtime quiz state, folder
 * membership and device-only rows. Each step is recorded when it lands.
 */
import {
  BrowserKVStore,
  type DocumentStore,
  type KVStore,
  type RuntimeStore,
} from '@openmaic/storage';

import {
  mergeLegacyAgentFallbacks,
  rosterNeedsLegacyFallback,
} from '@/lib/classroom/load-classroom';
import type { AppDocument, AppStage } from '@/lib/document-store';
import { loadCurrentSceneValue, saveCurrentSceneValue } from '@/lib/document-store/current-scene';
import {
  readLegacyChatSessions,
  readLegacyDocumentSnapshots,
  readLegacyGeneratedAgents,
  readLegacyPlaybackState,
  type GeneratedAgentRecord,
} from '@/lib/legacy-browser-storage';
import { loadCursor, loadCursorValue, saveCursorValue } from '@/lib/playback/cursor';
import { readLegacyQuizStateSnapshot } from '@/lib/quiz/persistence';
import { importLegacyQuizSnapshot } from '@/lib/quiz/runtime';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { AppScene } from '@/lib/types/stage';
import { loadChatSessions } from '@/lib/utils/chat-storage';

import { copyCourseDeviceRows } from './device-rows';
import { classifyFailure, failureOrStop, ImportRunStop } from './errors';
import type { FolderApi } from './folders';
import { freshStageId } from './ids';
import { courseEntry, type CourseEntry, type ImportLedger } from './ledger';
import { fillLegacyMedia } from './media';
import { copyLegacyRuntime } from './runtime';
import { InvalidLegacyRecordError, readLegacyCourse, type LegacySources } from './sources';

export interface OwnedStage {
  readonly id: string;
  readonly folderId?: string;
}

/** Everything a course import needs, resolved once per run. */
export interface CourseImportContext {
  readonly ownerId: string;
  readonly storage: Storage;
  readonly kv: KVStore;
  readonly sources: LegacySources;
  readonly documents: DocumentStore<AppScene, AppStage>;
  readonly runtime: RuntimeStore;
  /** This owner's library, as listed at the start of the run. */
  readonly owned: Map<string, OwnedStage>;
  readonly folders: FolderApi;
  /** Legacy course id -> legacy folder id. */
  readonly membership: Map<string, string>;
  /** Scene ids that pre-runtime quiz keys name, and the legacy courses holding each. */
  readonly quizScenes: Map<string, Set<string>>;
  readonly ledger: ImportLedger;
  readonly checkpoint: () => void;
  readonly assetExists: (ref: string) => Promise<boolean>;
  readonly log: (message: string, ...details: unknown[]) => void;
  /** Set when the owner's library visibly changed (a course or its folder). */
  libraryChanged: boolean;
}

export function createKv(storage: Storage): KVStore {
  return new BrowserKVStore({ storage });
}

function agentConfig(record: GeneratedAgentRecord): GeneratedAgentConfig {
  // Historical rows spread the whole generated profile, so a row may carry a
  // voiceConfig the declared record type does not list.
  const voiceConfig = (record as { voiceConfig?: GeneratedAgentConfig['voiceConfig'] }).voiceConfig;
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    persona: record.persona,
    avatar: record.avatar,
    color: record.color,
    priority: record.priority,
    ...(voiceConfig ? { voiceConfig } : {}),
    ...(record.voiceDesign ? { voiceDesign: record.voiceDesign } : {}),
  };
}

/** The document as it is written under `stageId`. */
async function documentForServer(
  original: AppDocument,
  legacyStageId: string,
  stageId: string,
): Promise<AppDocument> {
  const document = structuredClone(original);
  if (stageId !== legacyStageId) {
    document.stage.id = stageId;
    for (const scene of document.scenes) scene.stageId = stageId;
  }
  // A roster from before it lived on the stage document is lifted from the
  // old table, the way the classroom loader used to on open.
  if (rosterNeedsLegacyFallback(document.stage.generatedAgentConfigs)) {
    const fallbacks = (await readLegacyGeneratedAgents(legacyStageId)).map(agentConfig);
    const merged = mergeLegacyAgentFallbacks(document.stage.generatedAgentConfigs ?? [], fallbacks);
    if (merged.changed) document.stage.generatedAgentConfigs = merged.configs;
  }
  return document;
}

/**
 * Decide where the course goes and create it there. Leaves `entry.target`,
 * `entry.origin` and the `document` step set, or marks the course skipped.
 */
async function settleDocument(
  context: CourseImportContext,
  legacyStageId: string,
  entry: CourseEntry,
): Promise<void> {
  const fresh = freshStageId(legacyStageId, context.ownerId);
  const markDocument = (target: string, origin: CourseEntry['origin']) => {
    Object.assign(entry, { target, origin });
    entry.steps.document = 'done';
    context.checkpoint();
  };

  // A save whose ledger write was lost: the owner lists the target already.
  if (entry.target && context.owned.has(entry.target)) {
    markDocument(entry.target, entry.origin ?? 'created');
    return;
  }
  if (!entry.target) {
    if (context.owned.has(legacyStageId)) {
      markDocument(legacyStageId, 'existing');
      return;
    }
    if (context.owned.has(fresh)) {
      markDocument(fresh, 'created');
      return;
    }
  }

  const course = await readLegacyCourse(context.sources, legacyStageId);
  if (!course) {
    Object.assign(entry, { status: 'skipped', reason: 'no longer in this browser' });
    context.checkpoint();
    return;
  }

  if (!entry.target) {
    // Readable by id but not in this owner's library: another owner holds it.
    const taken = (await context.documents.loadDocument(legacyStageId)) !== null;
    Object.assign(entry, { target: taken ? fresh : legacyStageId, origin: 'created' });
    context.checkpoint();
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = entry.target!;
    try {
      await context.documents.saveDocument(
        await documentForServer(course.document, legacyStageId, target),
      );
      break;
    } catch (error) {
      const failure = failureOrStop(error);
      if (failure.kind === 'forbidden' && target !== fresh) {
        // Taken between the check and the write, or held under a tombstone
        // another owner left: import under the fresh id instead.
        entry.target = fresh;
        context.checkpoint();
        continue;
      }
      if (failure.kind === 'not-found') {
        // This owner deleted the course on the server; the deletion stands.
        Object.assign(entry, { status: 'skipped', reason: 'deleted on the server' });
        context.checkpoint();
        return;
      }
      throw error;
    }
  }
  if (course.currentSceneId) {
    const existing = await loadCurrentSceneValue(entry.target!, context.kv);
    if (!existing) {
      await saveCurrentSceneValue(
        entry.target!,
        {
          sceneId: course.currentSceneId,
          updatedAt: new Date(course.document.stage.updatedAt ?? Date.now()).toISOString(),
        },
        context.kv,
      );
    }
  }
  context.libraryChanged = true;
  markDocument(entry.target!, 'created');
}

async function copyChat(context: CourseImportContext, legacyStageId: string, stageId: string) {
  const rows = await readLegacyChatSessions(legacyStageId);
  if (rows.length === 0) return;
  const moved = rows.map((row) => ({ ...row, stageId }));
  await loadChatSessions(stageId, {
    store: context.runtime,
    learnerKey: context.ownerId,
    // Read-only: the old rows stay where they are.
    legacyStore: { load: async () => moved, clear: async () => undefined },
    observe: false,
    fallbackToLegacyOnError: false,
  });
}

async function copyPlayback(
  context: CourseImportContext,
  legacyStageId: string,
  document: AppDocument,
) {
  const stageId = document.stage.id;
  const { kv } = context;
  if (stageId !== legacyStageId) {
    // Device positions this browser already kept under the old id.
    const cursor = await loadCursorValue(legacyStageId, kv);
    if (cursor && !(await loadCursorValue(stageId, kv))) {
      await saveCursorValue(stageId, cursor, kv);
    }
    const scene = await loadCurrentSceneValue(legacyStageId, kv);
    if (scene && !(await loadCurrentSceneValue(stageId, kv))) {
      await saveCurrentSceneValue(stageId, scene, kv);
    }
  }
  const row = await readLegacyPlaybackState(legacyStageId);
  if (!row) return;
  const ordered = [...document.scenes].sort((a, b) => a.order - b.order);
  const sceneId = ordered[row.sceneIndex]?.id;
  if (!sceneId) return;
  await loadCursor(stageId, {
    kv,
    legacyStore: {
      get: async () => ({ ...row, stageId, sceneId }),
      // Read-only: the old row stays where it is.
      delete: async () => undefined,
    },
  });
}

async function copyQuizState(
  context: CourseImportContext,
  legacyStageId: string,
  document: AppDocument,
) {
  for (const scene of document.scenes) {
    const holders = context.quizScenes.get(scene.id);
    if (!holders) continue;
    // The keys name a scene, not a course. A scene id two legacy courses share
    // (a duplicated course) cannot say whose answers these are: skipped.
    if (holders.size !== 1 || !holders.has(legacyStageId)) {
      context.log(`Quiz state of scene ${scene.id} is ambiguous and was not imported`);
      continue;
    }
    const snapshot = readLegacyQuizStateSnapshot(scene.id);
    if (!snapshot.hasState) continue;
    await importLegacyQuizSnapshot({ stageId: document.stage.id, sceneId: scene.id }, snapshot, {
      store: context.runtime,
      learnerKey: context.ownerId,
    });
  }
}

/** File the course in the server folder its legacy folder maps to. `false` = retry later. */
async function copyMembership(
  context: CourseImportContext,
  legacyStageId: string,
  entry: CourseEntry,
): Promise<boolean> {
  const stageId = entry.target!;
  // An existing server course that is already filed keeps its folder.
  if (entry.origin === 'existing' && context.owned.get(stageId)?.folderId) return true;
  const legacyFolderId = context.membership.get(legacyStageId);
  if (!legacyFolderId) return true;
  const folder = context.ledger.folders[legacyFolderId];
  if (!folder || folder.status === 'pending') return false;
  if (folder.status !== 'done' || !folder.serverId) return true; // the folder could not be created
  await context.folders.setMembership(stageId, folder.serverId);
  context.libraryChanged = true;
  return true;
}

async function runCourse(
  context: CourseImportContext,
  legacyStageId: string,
  entry: CourseEntry,
): Promise<void> {
  if (!entry.steps.document) {
    await settleDocument(context, legacyStageId, entry);
    if (entry.status !== 'pending') return;
  }
  const stageId = entry.target!;
  const step = (name: keyof CourseEntry['steps']) => {
    entry.steps[name] = 'done';
    context.checkpoint();
  };

  let document = await context.documents.loadDocument(stageId);
  if (!document) {
    // Deleted on the server after the import began: the deletion stands.
    Object.assign(entry, { status: 'skipped', reason: 'deleted on the server' });
    context.checkpoint();
    return;
  }

  if (!entry.steps.media) {
    const media = await fillLegacyMedia(document, {
      stageId,
      legacyStageId,
      sources: context.sources,
      assetExists: context.assetExists,
      entry,
      checkpoint: context.checkpoint,
    });
    if (media.converted > 0) document = (await context.documents.loadDocument(stageId)) ?? document;
    if (media.pending === 0) step('media');
  }

  if (entry.origin === 'created') {
    if (!entry.steps.runtime) {
      if (context.sources.runtime && context.sources.learnerKey) {
        await copyLegacyRuntime({
          legacy: context.sources.runtime,
          legacyLearnerKey: context.sources.learnerKey,
          server: context.runtime,
          learnerKey: context.ownerId,
          legacyStageId,
          stageId,
          entry,
          checkpoint: context.checkpoint,
          log: context.log,
        });
      }
      step('runtime');
    }
    if (!entry.steps.chat) {
      await copyChat(context, legacyStageId, stageId);
      step('chat');
    }
    if (!entry.steps.playback) {
      await copyPlayback(context, legacyStageId, document);
      step('playback');
    }
    if (!entry.steps.quiz) {
      await copyQuizState(context, legacyStageId, document);
      step('quiz');
    }
  }

  if (!entry.steps.folder && (await copyMembership(context, legacyStageId, entry))) step('folder');
  if (!entry.steps.deviceRows) {
    await copyCourseDeviceRows(document, legacyStageId);
    step('deviceRows');
  }

  const pendingMedia = Object.values(entry.media ?? {}).filter((m) => m.status === 'pending');
  if (entry.steps.media && entry.steps.folder) {
    entry.status = 'done';
    delete entry.reason;
  } else {
    entry.reason =
      pendingMedia.length > 0 ? `media pending: ${pendingMedia[0]!.reason}` : 'folder pending';
  }
  context.checkpoint();
}

/**
 * Import one course, recording its outcome. Throws only `ImportRunStop`; any
 * other failure is recorded on the course (pending for a later load when it
 * may pass, failed or skipped when it cannot).
 */
export async function importLegacyCourse(
  context: CourseImportContext,
  legacyStageId: string,
  seed?: Pick<CourseEntry, 'target' | 'origin'>,
): Promise<void> {
  const entry = courseEntry(context.ledger, legacyStageId);
  if (entry.status !== 'pending') return;
  if (seed && !entry.target) {
    Object.assign(entry, seed);
    entry.steps.document = 'done';
  }
  try {
    await runCourse(context, legacyStageId, entry);
  } catch (error) {
    if (error instanceof ImportRunStop) {
      if (error.failure.kind === 'owner') {
        Object.assign(entry, { status: 'failed', reason: error.failure.reason });
      } else {
        entry.reason = error.failure.reason;
      }
      context.checkpoint();
      throw error;
    }
    if (error instanceof InvalidLegacyRecordError) {
      Object.assign(entry, {
        status: 'skipped',
        reason: `invalid legacy record: ${error.message}`,
      });
      context.checkpoint();
      context.log(`Course ${legacyStageId} was skipped:`, error.message);
      return;
    }
    const failure = classifyFailure(error);
    if (failure.kind === 'transient' || failure.kind === 'quota') {
      entry.reason = failure.reason;
    } else {
      Object.assign(entry, { status: 'failed', reason: failure.reason });
    }
    context.checkpoint();
    context.log(`Course ${legacyStageId} was not imported (${entry.status}):`, error);
  }
}

/** The legacy course the pre-document-store tables keep, if any (for the quiz scene index). */
export async function legacySceneIds(
  sources: LegacySources,
  legacyStageId: string,
): Promise<string[]> {
  if (sources.documents) {
    const document = await sources.documents.loadDocument(legacyStageId).catch(() => null);
    if (document) return document.scenes.map((scene) => scene.id);
  }
  const snapshot = await readLegacyDocumentSnapshots()
    .read(legacyStageId)
    .catch(() => null);
  return snapshot ? snapshot.scenes.map((scene) => scene.id) : [];
}
