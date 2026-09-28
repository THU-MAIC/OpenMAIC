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
import { preparePBLScenesForDocumentPersistence } from '@/lib/pbl/v2/runtime/document-persistence';
import type { AppScene, GeneratedAgentConfig, Scene } from '@/lib/types/stage';
import { fromLegacyRecords, loadChatSessions } from '@/lib/utils/chat-storage';

import { copyCourseDeviceRows } from './device-rows';
import { asRunStop, classifyFailure, failureOrStop } from './errors';
import type { FolderApi } from './folders';
import { freshStageId } from './ids';
import { courseEntry, READ_FAILURE_BUDGET, type CourseEntry, type ImportLedger } from './ledger';
import { fillLegacyMedia } from './media';
import { copyLegacyRuntime } from './runtime';
import type { ImportClients } from './server';
import {
  InvalidLegacyRecordError,
  LegacyReadError,
  readLegacyCourse,
  unlessUnusable,
  type LegacySources,
  type SpeechHolders,
} from './sources';

export interface OwnedStage {
  readonly id: string;
  readonly folderId?: string;
}

/** Everything a course import needs, resolved once per run. */
export interface CourseImportContext {
  /** The runtime learner key of the owner holding the binding, asked this run. */
  readonly learnerKey: string;
  readonly storage: Storage;
  readonly kv: KVStore;
  readonly sources: LegacySources;
  /** The fenced server clients (`./server.ts`); every write goes through them. */
  readonly clients: ImportClients;
  readonly documents: DocumentStore<AppScene, AppStage>;
  readonly runtime: RuntimeStore;
  /** This owner's library, as listed at the start of the run. */
  readonly initiallyOwned: ReadonlySet<string>;
  /** This owner's library as last listed; `refreshOwned` lists it again. */
  readonly owned: Map<string, OwnedStage>;
  readonly refreshOwned: () => Promise<void>;
  /** Derived speech audio id -> the legacy courses whose speech actions name it. */
  speechHolders: () => Promise<SpeechHolders>;
  readonly folders: FolderApi;
  /** Legacy course id -> legacy folder id. */
  readonly membership: Map<string, string>;
  /** Scene ids the pre-runtime quiz keys name. */
  readonly quizKeyScenes: ReadonlySet<string>;
  /** Scene ids that pre-runtime quiz keys name, and the legacy courses holding each. */
  readonly quizScenes: Map<string, Set<string>>;
  /** Courses the quiz-scene index could not read this run. */
  readonly quizUnindexed: Set<string>;
  readonly ledger: ImportLedger;
  readonly checkpoint: () => void;
  /** This run's clock (epoch ms). */
  readonly now: number;
  /** Courses whose storage read already failed this run (counted once per run). */
  readonly readFailedThisRun: Set<string>;
  /** Legacy courses a storage read succeeded for during this run. */
  readonly readSucceededThisRun: Set<string>;
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
  runtime: { store: RuntimeStore; learnerKey: string },
): Promise<AppDocument> {
  const document = structuredClone(original);
  if (stageId !== legacyStageId) {
    document.stage.id = stageId;
    for (const scene of document.scenes) scene.stageId = stageId;
  }
  // The regular save paths strip PBL v2 learner state to the design template
  // (moving it to the runtime); an imported document gets the same boundary.
  document.scenes = (await preparePBLScenesForDocumentPersistence(
    stageId,
    document.scenes as Scene[],
    runtime,
  )) as AppScene[];
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
 * Answers false when another tab of this browser is importing the course right
 * now (a browser without Web Locks); a later load settles it.
 */
async function settleDocument(
  context: CourseImportContext,
  legacyStageId: string,
  entry: CourseEntry,
): Promise<boolean> {
  const fresh = freshStageId(legacyStageId, context.ledger.browserId);
  const markDocument = (target: string, origin: CourseEntry['origin']) => {
    Object.assign(entry, { target, origin });
    entry.steps.document = 'done';
    context.checkpoint();
  };

  // A save whose ledger write was lost: the owner lists the target already.
  if (entry.target && context.owned.has(entry.target)) {
    markDocument(entry.target, entry.origin ?? 'created');
    return true;
  }
  if (!entry.target) {
    if (context.initiallyOwned.has(legacyStageId)) {
      markDocument(legacyStageId, 'existing');
      return true;
    }
    if (context.initiallyOwned.has(fresh)) {
      markDocument(fresh, 'created');
      return true;
    }
  }

  const course = await readLegacyCourse(
    context.sources,
    legacyStageId,
    readBudgetSpent(context.ledger.courses[legacyStageId], context.now),
  );
  if (!course) {
    Object.assign(entry, { status: 'skipped', reason: 'no longer in this browser' });
    context.checkpoint();
    return true;
  }

  if (!entry.target) {
    // Readable by id means someone holds it. The library is listed again
    // AFTER that read, so a copy another tab of this browser saved in the
    // meantime shows up as this owner's instead of passing for another
    // owner's (which would import a second copy under the fresh id).
    const taken = (await context.documents.loadDocument(legacyStageId)) !== null;
    await context.refreshOwned();
    if (context.owned.has(legacyStageId) || context.owned.has(fresh)) {
      context.log(`Course ${legacyStageId} is being imported by another tab; leaving it to it`);
      return false;
    }
    Object.assign(entry, { target: taken ? fresh : legacyStageId, origin: 'created' });
    context.checkpoint();
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = entry.target!;
    try {
      await context.documents.saveDocument(
        await documentForServer(course.document, legacyStageId, target, {
          store: context.runtime,
          learnerKey: context.learnerKey,
        }),
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
        return true;
      }
      throw error;
    }
  }
  for (const note of course.notes ?? []) addNote(entry, note);
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
  return true;
}

async function copyChat(
  context: CourseImportContext,
  legacyStageId: string,
  stageId: string,
  entry: CourseEntry,
) {
  const rows = await readLegacyChatSessions(legacyStageId);
  if (rows.length === 0) return;
  const moved = rows.map((row) => ({ ...row, stageId }));
  // Rows the chat serializer cannot convert stay in the browser (the regular
  // path left them there too); say so rather than drop them silently.
  const skipped = fromLegacyRecords(moved).skippedRows.length;
  if (skipped > 0) {
    addNote(entry, `${skipped} chat session(s) could not be converted and stay in this browser`);
    context.log(`Course ${legacyStageId}: ${skipped} chat session(s) could not be converted`);
  }
  await loadChatSessions(stageId, {
    store: context.runtime,
    learnerKey: context.learnerKey,
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

/** Copy the course's pre-runtime quiz state. `false` = undecided (retry on a later run). */
async function copyQuizState(
  context: CourseImportContext,
  legacyStageId: string,
  document: AppDocument,
): Promise<boolean> {
  for (const scene of document.scenes) {
    if (!context.quizKeyScenes.has(scene.id)) continue;
    // A course the index could not read might name this scene too; until it
    // can be read (or settles), whose answers these are is undecided.
    if (context.quizUnindexed.size > 0) return false;
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
      learnerKey: context.learnerKey,
    });
  }
  return true;
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
  // A membership row naming a folder the old database no longer has: unfiled.
  if (!folder) return true;
  if (folder.status === 'pending') return false;
  if (folder.status !== 'done' || !folder.serverId) return true; // the folder could not be created
  try {
    await context.folders.setMembership(stageId, folder.serverId);
  } catch (error) {
    const failure = failureOrStop(error);
    if (failure.kind === 'transient' || failure.kind === 'quota') throw error;
    // The folder is gone (deleted meanwhile) or refused: the course is on the
    // server either way, it just stays unfiled.
    addNote(entry, `left unfiled: ${failure.reason}`);
    return true;
  }
  context.libraryChanged = true;
  return true;
}

function addNote(entry: CourseEntry, note: string): void {
  const notes = (entry.notes ??= []);
  if (!notes.includes(note)) notes.push(note);
}

async function runCourse(
  context: CourseImportContext,
  legacyStageId: string,
  entry: CourseEntry,
): Promise<void> {
  if (!entry.steps.document) {
    if (!(await settleDocument(context, legacyStageId, entry))) return;
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
      speechHolders: context.speechHolders,
      documents: context.documents,
      putAsset: (data, meta) => context.clients.putAsset(data, meta),
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
          learnerKey: context.learnerKey,
          legacyStageId,
          stageId,
          entry,
          checkpoint: context.checkpoint,
          log: context.log,
        });
      } else if (context.sources.runtime) {
        // The browser runtime store lists sessions only by learner key, and the
        // key it used is no longer in this browser's localStorage.
        addNote(entry, 'learner runtime not imported: the old device learner key is gone');
        context.log(`Course ${legacyStageId}: the old device learner key is gone; runtime skipped`);
      }
      step('runtime');
    }
    if (!entry.steps.chat) {
      await copyChat(context, legacyStageId, stageId, entry);
      step('chat');
    }
    if (!entry.steps.playback) {
      await copyPlayback(context, legacyStageId, document);
      step('playback');
    }
    if (!entry.steps.quiz && (await copyQuizState(context, legacyStageId, document))) {
      step('quiz');
    }
  }

  if (!entry.steps.folder && (await copyMembership(context, legacyStageId, entry))) step('folder');
  if (!entry.steps.deviceRows) {
    await copyCourseDeviceRows(document, legacyStageId);
    step('deviceRows');
  }

  const pendingMedia = Object.values(entry.media ?? {}).filter((m) => m.status === 'pending');
  const quizPending = entry.origin === 'created' && !entry.steps.quiz;
  if (entry.steps.media && entry.steps.folder && !quizPending) {
    entry.status = 'done';
    delete entry.reason;
  } else {
    entry.reason =
      pendingMedia.length > 0
        ? `media pending: ${pendingMedia[0]!.reason}`
        : quizPending
          ? 'quiz state pending: another legacy course could not be read yet'
          : 'folder pending';
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
    try {
      await runCourse(context, legacyStageId, entry);
      context.readSucceededThisRun.add(legacyStageId);
    } catch (error) {
      if (!(error instanceof LegacyReadError)) throw error;
      // The old storage failed to read this course. It stays pending; once it
      // has failed in enough runs over enough time, it settles on what can be
      // read (the table copy, or a skip) instead of holding the import open.
      noteReadFailure(context, entry, legacyStageId);
      if (!readBudgetSpent(entry, context.now)) throw error;
      await runCourse(context, legacyStageId, entry);
    }
  } catch (error) {
    // A run-level failure from any call of the course -- the "is the id
    // taken" read, the library re-list, the chat or quiz copy -- stops the run
    // and leaves the course pending, exactly like one from a wrapped call.
    const stop = asRunStop(error);
    if (stop) {
      entry.reason = stop.failure.reason;
      context.checkpoint();
      throw stop;
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

/**
 * The scene ids of a legacy course, for the quiz-scene index. A storage
 * failure throws `LegacyReadError` (the course is left out of the index and
 * holds up only the quiz decisions it could affect); once the course's read
 * budget is spent (`settle`), whatever can be read is used instead.
 */
export async function legacySceneIds(
  sources: LegacySources,
  legacyStageId: string,
  settle = false,
): Promise<string[]> {
  const documents = sources.documents;
  if (documents) {
    try {
      const document = await unlessUnusable(() => documents.loadDocument(legacyStageId));
      if (document) return document.scenes.map((scene) => scene.id);
    } catch (error) {
      if (!settle) throw new LegacyReadError(legacyStageId, error);
    }
  }
  try {
    const snapshot = await unlessUnusable(() => readLegacyDocumentSnapshots().read(legacyStageId));
    return snapshot ? snapshot.scenes.map((scene) => scene.id) : [];
  } catch (error) {
    if (!settle) throw new LegacyReadError(legacyStageId, error);
    return [];
  }
}

/** Whether a course's storage reads have failed often enough, for long enough, to settle it. */
export function readBudgetSpent(entry: CourseEntry | undefined, now: number): boolean {
  const failures = entry?.readFailures;
  // A first failure recorded while the clock ran ahead counts from now (the
  // next failure rewrites it), so it never holds the course open until then.
  return (
    failures !== undefined &&
    failures.count >= READ_FAILURE_BUDGET.runs &&
    now - Math.min(failures.since, now) >= READ_FAILURE_BUDGET.spanMs
  );
}

/** Count a storage read failure of a course, once per run. */
function noteReadFailure(
  context: CourseImportContext,
  entry: CourseEntry,
  legacyStageId: string,
): void {
  if (context.readFailedThisRun.has(legacyStageId)) return;
  context.readFailedThisRun.add(legacyStageId);
  const previous = entry.readFailures;
  entry.readFailures = {
    count: (previous?.count ?? 0) + 1,
    since: previous !== undefined && previous.since <= context.now ? previous.since : context.now,
  };
  context.checkpoint();
}

/**
 * Forget the read failures of every course that read without one in this run:
 * the budget counts consecutive failing runs, so a course that recovered does
 * not settle on the next single failure a day later. Called at the end of a
 * run.
 */
export function forgetRecoveredReadFailures(context: CourseImportContext): void {
  let changed = false;
  for (const legacyStageId of context.readSucceededThisRun) {
    if (context.readFailedThisRun.has(legacyStageId)) continue;
    const entry = context.ledger.courses[legacyStageId];
    if (entry?.readFailures === undefined) continue;
    delete entry.readFailures;
    changed = true;
  }
  if (changed) context.checkpoint();
}

/**
 * Run a read of a legacy course under its read budget: a storage failure is
 * counted and answers undefined (the caller treats the course as unindexed),
 * and once the budget is spent the read runs again in settle mode.
 */
export async function readWithBudget<T>(
  context: CourseImportContext,
  legacyStageId: string,
  read: (settle: boolean) => Promise<T>,
): Promise<T | undefined> {
  const entry = courseEntry(context.ledger, legacyStageId);
  if (readBudgetSpent(entry, context.now)) return read(true);
  try {
    const value = await read(false);
    context.readSucceededThisRun.add(legacyStageId);
    return value;
  } catch (error) {
    if (!(error instanceof LegacyReadError)) throw error;
    noteReadFailure(context, entry, legacyStageId);
    if (readBudgetSpent(entry, context.now)) return read(true);
    return undefined;
  }
}
