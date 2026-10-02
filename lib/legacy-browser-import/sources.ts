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
  /** Why this copy was used (an unreadable newer copy), for the ledger. */
  notes?: string[];
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

/**
 * The old browser storage failed to read a course (not an unusable record: the
 * storage itself). Transient as far as the ledger is concerned: the course
 * stays pending, and the failure counts towards its read budget
 * (`READ_FAILURE_BUDGET`, `course.ts`).
 */
export class LegacyReadError extends Error {
  override readonly name = 'LegacyReadError';

  constructor(
    readonly stageId: string,
    override readonly cause: unknown,
  ) {
    super(
      `the old browser storage could not read course ${JSON.stringify(stageId)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

/** A read that answers null for an unusable record and rethrows a storage failure. */
export async function unlessUnusable<T>(read: () => Promise<T>): Promise<T | null> {
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
 *
 * A storage failure throws `LegacyReadError` and leaves the course pending:
 * falling back to the tables then would import an older copy for good while
 * the newer one is merely unreadable right now. Once the course's read budget
 * is spent (`settle`), a document-store copy that still cannot be read falls
 * back to the tables copy when there is one, and the course is skipped with
 * the reason when there is not.
 */
export async function readLegacyCourse(
  sources: LegacySources,
  stageId: string,
  settle = false,
): Promise<LegacyCourse | null> {
  let unreadable: InvalidLegacyRecordError | undefined;
  if (sources.documents) {
    let document: AppDocument | null = null;
    try {
      document = await sources.documents.loadDocument(stageId);
      if (document) assertImportable(document, stageId);
    } catch (error) {
      if (!isUnusableRecordError(error)) {
        if (!settle) throw new LegacyReadError(stageId, error);
        unreadable = new InvalidLegacyRecordError(
          `the document-store copy of ${JSON.stringify(stageId)} could not be read in this browser, repeatedly: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // A document that cannot be migrated or validated is unusable as is.
      // The original tables may still hold a usable (older) copy.
      unreadable ??=
        error instanceof InvalidLegacyRecordError
          ? error
          : new InvalidLegacyRecordError(
              `document ${JSON.stringify(stageId)} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
            );
      document = null;
    }
    if (document) return { document, source: 'documents' };
  }
  let snapshot: Awaited<ReturnType<ReturnType<typeof readLegacyDocumentSnapshots>['read']>>;
  try {
    snapshot = await readLegacyDocumentSnapshots().read(stageId);
  } catch (error) {
    if (isUnusableRecordError(error)) throw new InvalidLegacyRecordError(String(error));
    if (!settle) throw new LegacyReadError(stageId, error);
    throw (
      unreadable ??
      new InvalidLegacyRecordError(
        `course ${JSON.stringify(stageId)} could not be read in this browser, repeatedly`,
      )
    );
  }
  if (!snapshot) {
    if (unreadable) throw unreadable;
    return null;
  }
  const notes = unreadable ? [`imported from the older table copy: ${unreadable.message}`] : [];
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
    ...(notes.length > 0 ? { notes } : {}),
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

/** Derived speech audio ids and the legacy courses naming each, from the courses that could be read. */
export interface SpeechHolders {
  readonly holders: Map<string, Set<string>>;
  /** Courses the old storage failed to read this run: a lookup they could affect is undecided. */
  readonly unindexed: Set<string>;
}

/**
 * Every derived speech audio id, and the legacy courses whose speech actions
 * name it. A narration row from before the course column names no course; a
 * key only one legacy course uses can still only be that course's.
 *
 * `read(id, reader)` runs each course's read under that course's read budget
 * (`readWithBudget` in `course.ts`): a course whose storage fails is left out
 * and listed as unindexed, which holds up only the lookups it could affect.
 */
export async function legacySpeechHolders(
  sources: LegacySources,
  legacyIds: readonly string[],
  read: <T>(stageId: string, reader: (settle: boolean) => Promise<T>) => Promise<T | undefined>,
): Promise<SpeechHolders> {
  const holders = new Map<string, Set<string>>();
  const unindexed = new Set<string>();
  for (const stageId of legacyIds) {
    const lists = await read(stageId, async (settle) => {
      const found: { actions?: unknown[] }[][] = [];
      const documents = sources.documents;
      try {
        const document = documents
          ? await unlessUnusable(() => documents.loadDocument(stageId))
          : null;
        if (document) found.push(document.scenes as { actions?: unknown[] }[]);
      } catch (error) {
        if (!settle) throw new LegacyReadError(stageId, error);
      }
      try {
        const snapshot = await unlessUnusable(() => readLegacyDocumentSnapshots().read(stageId));
        if (snapshot) found.push(snapshot.scenes as { actions?: unknown[] }[]);
      } catch (error) {
        if (!settle) throw new LegacyReadError(stageId, error);
      }
      return found;
    });
    if (lists === undefined) {
      unindexed.add(stageId);
      continue;
    }
    const seen = new Set<string>();
    for (const scenes of lists) {
      for (const scene of scenes) {
        for (const action of scene.actions ?? []) {
          const speech = action as { type?: unknown; audioId?: unknown };
          if (speech.type !== 'speech' || typeof speech.audioId !== 'string') continue;
          if (speech.audioId === '' || seen.has(speech.audioId)) continue;
          seen.add(speech.audioId);
          const set = holders.get(speech.audioId) ?? new Set<string>();
          set.add(stageId);
          holders.set(speech.audioId, set);
        }
      }
    }
  }
  return { holders, unindexed };
}
