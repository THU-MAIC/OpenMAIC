/**
 * What this browser still holds from before persistence moved to the server,
 * read through the read-only legacy module. Nothing here writes.
 */
import { DocumentVersionError } from '@openmaic/storage';

import {
  canonicalizeLegacySnapshot,
  validateAppScene,
  validateAppStage,
  type AppDocument,
} from '@/lib/document-store';
import { migrateDocumentForVerification } from '@/lib/document-store/migration';
import {
  openLegacyAssetReader,
  openLegacyDocumentReader,
  openLegacyRuntimeReader,
  readLegacyAudioFileStageIndex,
  readLegacyDocumentSnapshots,
  readLegacyLearnerKey,
  readLegacyMediaFileStageIds,
  type LegacyAssetReader,
  type LegacyDocumentReader,
  type LegacyRuntimeReader,
  type StageRecord,
} from '@/lib/legacy-browser-storage';

/** One browser's legacy stores, opened once per run. */
export interface LegacySources {
  documents: LegacyDocumentReader | null;
  runtime: LegacyRuntimeReader | null;
  assets: LegacyAssetReader | null;
  /** The device learner key the browser runtime store was partitioned by. */
  learnerKey: string | null;
  close(): Promise<void>;
}

export async function openLegacySources(storage: Storage): Promise<LegacySources> {
  const [documents, runtime, assets, learnerKey] = await Promise.all([
    openLegacyDocumentReader(),
    openLegacyRuntimeReader(),
    openLegacyAssetReader(),
    readLegacyLearnerKey(storage),
  ]);
  return {
    documents,
    runtime,
    assets,
    learnerKey,
    async close() {
      await assets?.close().catch(() => undefined);
    },
  };
}

/** The ids of every course this browser holds, in both legacy course stores. */
export async function listLegacyCourseIds(sources: LegacySources): Promise<string[]> {
  const ids = new Set<string>();
  if (sources.documents) {
    for (const summary of await sources.documents.listDocuments()) ids.add(summary.id);
  }
  for (const stage of await readLegacyDocumentSnapshots().listStages()) ids.add(stage.id);
  return [...ids].sort();
}

/** A legacy course, ready to become a server document. */
export interface LegacyCourse {
  document: AppDocument;
  /** The device playback position a pre-document-store row kept on the stage. */
  currentSceneId?: string;
  /** Where it came from: the browser document store, or the original tables. */
  source: 'documents' | 'tables';
}

/** A legacy record the importer cannot use as it is; skipped, never retried. */
export class InvalidLegacyRecordError extends Error {
  override readonly name = 'InvalidLegacyRecordError';
}

/**
 * Whether a failed read says something about the record (it cannot be
 * migrated, parsed or validated) rather than about the storage reading it.
 * Only the first kind may settle a course as skipped; a storage failure (an
 * aborted IndexedDB transaction, a closed database) is transient and leaves
 * the course pending for a later load.
 */
export function isUnusableRecordError(error: unknown): boolean {
  if (error instanceof InvalidLegacyRecordError || error instanceof DocumentVersionError) {
    return true;
  }
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
    return true;
  }
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return false;
  // The DSL and storage packages report a record they cannot migrate or
  // accept with a prefixed message; storage failures are DOMExceptions or
  // Dexie errors, which carry no such prefix.
  return error instanceof Error && /^@openmaic\/(?:dsl|storage): /.test(error.message);
}

/** A read that answers null for an unusable record and rethrows a storage failure. */
async function unlessUnusable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isUnusableRecordError(error)) return null;
    throw error;
  }
}

/**
 * The checks the document store runs on a save, run first so a record it
 * would refuse is skipped as invalid instead of retried as a failed write.
 */
function assertImportable(original: AppDocument, stageId: string): void {
  let document: AppDocument;
  try {
    document = migrateDocumentForVerification(original);
  } catch (error) {
    throw new InvalidLegacyRecordError(
      `course ${JSON.stringify(stageId)} has no migration path: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stage = validateAppStage(document.stage);
  if (!stage.valid) {
    throw new InvalidLegacyRecordError(
      `stage ${JSON.stringify(stageId)} is invalid: ${stage.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const seen = new Set<string>();
  for (const scene of document.scenes) {
    const result = validateAppScene(scene);
    if (!result.valid || scene.stageId !== stageId || seen.has(scene.id)) {
      throw new InvalidLegacyRecordError(
        `scene ${JSON.stringify(scene.id)} of ${JSON.stringify(stageId)} is invalid`,
      );
    }
    seen.add(scene.id);
  }
}

/**
 * The course under this id. The browser document store wins over the original
 * tables: browser builds moved a course from the tables into the document
 * store on first open and kept editing it there, so a course present in both
 * is newer in the document store.
 */
export async function readLegacyCourse(
  sources: LegacySources,
  stageId: string,
): Promise<LegacyCourse | null> {
  let unreadable: InvalidLegacyRecordError | undefined;
  if (sources.documents) {
    let document: AppDocument | null = null;
    try {
      document = await sources.documents.loadDocument(stageId);
      if (document) assertImportable(document, stageId);
    } catch (error) {
      // A storage failure is not a verdict on the document: the course stays
      // pending and a later load reads it again. Falling back to the tables
      // here would import an older copy for good while the newer one is
      // merely unreadable right now.
      if (!isUnusableRecordError(error)) throw error;
      // A document that cannot be migrated or validated is unusable as is.
      // The original tables may still hold a usable (older) copy.
      unreadable =
        error instanceof InvalidLegacyRecordError
          ? error
          : new InvalidLegacyRecordError(
              `document ${JSON.stringify(stageId)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
            );
      document = null;
    }
    if (document) return { document, source: 'documents' };
  }
  const snapshot = await readLegacyDocumentSnapshots().read(stageId);
  if (!snapshot) {
    if (unreadable) throw unreadable;
    return null;
  }
  let document: AppDocument;
  try {
    document = canonicalizeLegacySnapshot(snapshot);
  } catch (error) {
    throw new InvalidLegacyRecordError(
      `course ${JSON.stringify(stageId)} cannot be converted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertImportable(document, stageId);
  const record: StageRecord = snapshot.stage;
  return {
    document,
    source: 'tables',
    ...(record.currentSceneId ? { currentSceneId: record.currentSceneId } : {}),
  };
}

/**
 * Course ids the old generated-media and narration tables name, and whether
 * some narration rows name no course at all (rows from before the column).
 */
export async function legacyMediaCourseIndex(): Promise<{
  stageIds: Set<string>;
  hasUnscopedNarration: boolean;
}> {
  const [media, audio] = await Promise.all([
    readLegacyMediaFileStageIds(),
    readLegacyAudioFileStageIndex(),
  ]);
  return {
    stageIds: new Set([...media, ...audio.stageIds]),
    hasUnscopedNarration: audio.hasUnscopedRows,
  };
}

/**
 * Every derived speech audio id, and the legacy courses whose speech actions
 * name it. A narration row from before the course column names no course; a
 * key only one legacy course uses can still only be that course's.
 */
export { unlessUnusable };

export async function legacySpeechHolders(
  sources: LegacySources,
  legacyIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const holders = new Map<string, Set<string>>();
  const add = (audioId: unknown, stageId: string) => {
    if (typeof audioId !== 'string' || audioId === '') return;
    const set = holders.get(audioId) ?? new Set<string>();
    set.add(stageId);
    holders.set(audioId, set);
  };
  for (const stageId of legacyIds) {
    const seen = new Set<string>();
    // A storage failure propagates (the run pauses): an index missing a
    // course would wrongly make a shared key look unique, or unowned.
    const scenesOf = async (): Promise<{ actions?: unknown[] }[][]> => {
      const lists: { actions?: unknown[] }[][] = [];
      const documents = sources.documents;
      const document = documents
        ? await unlessUnusable(() => documents.loadDocument(stageId))
        : null;
      if (document) lists.push(document.scenes as { actions?: unknown[] }[]);
      const snapshot = await unlessUnusable(() => readLegacyDocumentSnapshots().read(stageId));
      if (snapshot) lists.push(snapshot.scenes as { actions?: unknown[] }[]);
      return lists;
    };
    for (const scenes of await scenesOf()) {
      for (const scene of scenes) {
        for (const action of scene.actions ?? []) {
          const speech = action as { type?: unknown; audioId?: unknown };
          if (speech.type !== 'speech' || typeof speech.audioId !== 'string') continue;
          if (seen.has(speech.audioId)) continue;
          seen.add(speech.audioId);
          add(speech.audioId, stageId);
        }
      }
    }
  }
  return holders;
}
