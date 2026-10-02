/**
 * One-time import of the classrooms earlier versions stored as files.
 *
 * Before server-side generation wrote through the document store, a generated
 * classroom was `<CLASSROOMS_DIR>/<id>.json` (a `{ stage, scenes }` document)
 * with its images and videos under `<id>/media/` and its narration under
 * `<id>/audio/`, served by `/api/classroom-media/<id>/...`. Nothing reads that
 * store as a course any more, so a deployment that upgrades would lose every
 * such classroom's link. This moves them into the document store and the asset
 * pool once, at server start, in the background:
 *
 * - Each classroom keeps its id, so `/classroom/<id>` links keep working once
 *   it is imported (until then they show not-found). The save is create-only:
 *   an id any course already holds (a visitor who opened the classroom saved a
 *   copy under the same id, say) is never overwritten; that course stands and
 *   the file is recorded as skipped.
 * - Every `/api/classroom-media/<id>/...` reference to the classroom's own
 *   files — slide media, video posters, narration — is read from disk into the
 *   asset pool and rewritten to the allocated id, the shape a course generated
 *   today has. A slide reference whose file is gone is left as it was; a
 *   narration line whose clip is gone is left unvoiced, the shape a failed
 *   synthesis leaves. References to another classroom's files stay as they are
 *   and keep being served from that classroom's folder.
 * - The course is saved complete, sanitized, through the owner-bound store
 *   (`saveCompletedClassroom`), for the deployment's default owner
 *   ({@link resolveLegacyClassroomOwner}).
 * - Every classroom goes through the state machine of
 *   {@link importLegacyClassrooms}; outcomes land in a ledger
 *   (`lib/persistence/legacy-classroom-imports.ts`), the `imported` row in
 *   the course's own create transaction. Later runs skip what was settled.
 * - One instance imports at a time, under an advisory lock; another that
 *   finds it taken ends its run and retries later.
 * - The files are left in place, and the directory must stay: imported
 *   classrooms may still name another classroom's files, courses that kept an
 *   id may depend on their folder, and the agent runtime writes its media
 *   there.
 *
 * At boot rather than lazily on first open, because the file store has no
 * index the load path could consult cheaply and the legacy fallback read that
 * would have triggered it is gone; a boot pass also imports classrooms nobody
 * has opened yet.
 *
 * Temporary: remove with the ledger once deployments have upgraded past it.
 */
import { promises as fs } from 'fs';
import path from 'path';

import { isDocumentWriteRefusedError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createLogger } from '@/lib/logger';
import {
  MAX_IMPORT_ATTEMPTS,
  readSettledLegacyClassroomIds,
  recordLegacyClassroomFailure,
  recordLegacyClassroomImport,
} from '@/lib/persistence/legacy-classroom-imports';
import { assetPrincipalForOwner } from '@/lib/persistence/owner-assets';
import { CREATE_REFUSED, isStageIdTakenError } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { saveCompletedClassroom } from '@/lib/server/classroom-persistence';
import {
  CLASSROOMS_DIR,
  classroomMediaMimeType,
  isValidClassroomId,
} from '@/lib/server/classroom-storage';
import { resolveFixedOwnerId } from '@/lib/server/identity/registry';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';
import { isGeneratedMediaPlaceholder } from '@/lib/media/media-ref';
import { storeGeneratedAsset, type GeneratedAssetKind } from '@/lib/server/store-generated-asset';
import type { SpeechAction } from '@/lib/types/action';
import type { Scene, Stage } from '@/lib/types/stage';
import type { Slide } from '@openmaic/dsl';

const log = createLogger('LegacyClassroomImport');

/**
 * The owner imported classrooms belong to when the deployment has no fixed
 * owner (anonymous-cookie mode, or host-registered auth methods). The old file
 * store had no owners: a classroom was readable by anyone holding its link and
 * listed in nobody's library. Course reads are capability-by-id, so importing
 * under an owner no request resolves to keeps exactly that: every link opens
 * the classroom read-only, and it clutters no visitor's library. A visitor who
 * wants an editable copy exports it as a ZIP and imports it.
 */
export const LEGACY_CLASSROOM_OWNER_ID = 'system:legacy-classrooms';

/**
 * Advisory-lock key serializing imports across instances. Any fixed value
 * distinct from the application's other keys works.
 */
const IMPORT_LOCK_KEY = 71_310_524;

/**
 * Who imported classrooms belong to: the one owner every request resolves to
 * when the deployment has one (`PERSISTENCE_SHARED_OWNER_ID`, or single-user
 * mode), otherwise {@link LEGACY_CLASSROOM_OWNER_ID}.
 */
export function resolveLegacyClassroomOwner(): string {
  return resolveFixedOwnerId() ?? LEGACY_CLASSROOM_OWNER_ID;
}

export interface LegacyClassroomImportSummary {
  /** Classroom files found in the directory. */
  found: number;
  imported: number;
  /** Settled by an earlier run (a final ledger row exists). */
  alreadySettled: number;
  /** Settled as skipped this run, including classrooms that failed too often. */
  skipped: number;
  /** Failed this run and still pending: retried by a later run. */
  failed: number;
  mediaStored: number;
  /** References whose file was not on disk. */
  mediaMissing: number;
  /**
   * Why the run ended before reaching every classroom, if it did: another
   * instance holds the import lock, the owner's asset store is full, or the
   * run was stopped.
   */
  interrupted?: 'lock-busy' | 'storage-full' | 'stopped';
}

export interface ImportLegacyClassroomsOptions {
  /** Defaults to {@link CLASSROOMS_DIR}. */
  directory?: string;
  /** Defaults to {@link resolveLegacyClassroomOwner}. */
  ownerId?: string;
  /** Checked between classrooms: once aborted, the run ends there. */
  signal?: AbortSignal;
}

/** Whether a run leaves nothing to retry: every classroom reached and none pending. */
export function isLegacyClassroomImportComplete(summary: LegacyClassroomImportSummary): boolean {
  return summary.interrupted === undefined && summary.failed === 0;
}

const LEGACY_MEDIA_PATH = /^\/api\/classroom-media\/([^/]+)\/(media|audio)\/([^/]+)$/;

/**
 * The file a legacy serving reference names, when it names one of
 * `legacyId`'s own files: relative (`/api/classroom-media/...`, the agent
 * runtime's shape) or absolute (any origin; the generation pipeline wrote the
 * request origin in).
 */
function legacyMediaFile(value: string | undefined, legacyId: string): string | null {
  if (!value || !value.includes('/api/classroom-media/')) return null;
  let pathname: string;
  try {
    pathname = new URL(value, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const match = LEGACY_MEDIA_PATH.exec(pathname);
  if (!match) return null;
  let classroomId: string;
  let fileName: string;
  try {
    classroomId = decodeURIComponent(match[1]!);
    fileName = decodeURIComponent(match[3]!);
  } catch {
    return null;
  }
  if (classroomId !== legacyId) return null;
  if (fileName === '.' || fileName === '..' || /[/\\\0]/.test(fileName)) return null;
  return path.join(match[2]!, fileName);
}

function assetKindFor(mimeType: string, poster: boolean): GeneratedAssetKind {
  if (poster) return 'poster';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

class ImportRefusedError extends Error {}

/**
 * The owner's asset store refused for room. Not an outcome of the classroom:
 * the whole run stops, and a later run tries again once there is room.
 */
class ImportStorageFullError extends Error {}

interface ClassroomMediaImport {
  stored: number;
  missing: number;
}

/**
 * Move every legacy media reference of one document into the asset pool, in
 * place. Throws {@link ImportStorageFullError} when the pool refuses for room,
 * and the read error when a file cannot be read for a reason other than its
 * absence.
 */
async function importClassroomMedia(
  document: { stage: Stage; scenes: Scene[] },
  context: {
    directory: string;
    legacyId: string;
    ownerId: string;
    /** Receives every id allocated, so a failed attempt can release them. */
    allocations: string[];
  },
): Promise<ClassroomMediaImport> {
  // Resolved through symlinks, like each file below, so the containment check
  // compares real paths on both sides.
  let classroomRoot: string | null;
  try {
    classroomRoot = await fs.realpath(path.join(context.directory, context.legacyId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    classroomRoot = null;
  }
  const allocated = new Map<string, string | null>();
  const counts: ClassroomMediaImport = { stored: 0, missing: 0 };

  const assetFor = async (relativeFile: string, poster: boolean): Promise<string | null> => {
    const cached = allocated.get(relativeFile);
    if (cached !== undefined) return cached;
    let assetId: string | null = null;
    try {
      if (!classroomRoot) throw new ImportRefusedError();
      const realPath = await fs.realpath(path.join(classroomRoot, relativeFile));
      if (!realPath.startsWith(classroomRoot + path.sep)) throw new ImportRefusedError();
      const bytes = await fs.readFile(realPath);
      const mimeType = classroomMediaMimeType(path.extname(realPath)) ?? 'application/octet-stream';
      const stored = await storeGeneratedAsset({
        ownerId: context.ownerId,
        stageId: document.stage.id,
        bytes,
        mimeType,
        kind: assetKindFor(mimeType, poster),
      });
      if (stored.status === 'refused') throw new ImportStorageFullError();
      assetId = stored.assetId;
      context.allocations.push(assetId);
      counts.stored += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof ImportRefusedError)) throw error;
      counts.missing += 1;
    }
    allocated.set(relativeFile, assetId);
    return assetId;
  };

  const slides: Pick<Slide, 'background' | 'elements'>[] = [...(document.stage.whiteboard ?? [])];
  for (const scene of document.scenes) {
    if (scene.content?.type === 'slide') slides.push(scene.content.canvas);
    slides.push(...(scene.whiteboards ?? []));
  }
  for (const slide of slides) {
    const slots = [...slideMediaReferenceSlots(slide)];
    const rewrittenVideos = new Map<number, string>();
    for (const slot of slots) {
      const file = legacyMediaFile(slot.read(), context.legacyId);
      if (!file) continue;
      const assetId = await assetFor(file, slot.kind === 'video-poster');
      if (!assetId) continue;
      slot.write(assetId);
      if (slot.kind === 'video-src' && slot.elementIndex !== undefined) {
        rewrittenVideos.set(slot.elementIndex, assetId);
      }
    }
    // Playback resolves a video through `mediaRef` before `src`. The file
    // store kept the generation placeholder there beside a concrete `src`
    // URL, which won; next to an allocated id it would win instead, so it
    // moves to the same id.
    for (const slot of slots) {
      if (slot.kind !== 'video-media-ref' || slot.elementIndex === undefined) continue;
      const assetId = rewrittenVideos.get(slot.elementIndex);
      if (assetId && isGeneratedMediaPlaceholder(slot.read())) slot.write(assetId);
    }
  }

  for (const scene of document.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech') continue;
      // The file store paired a derived `audioId` with the serving URL in
      // `audioUrl`; a course today names one allocated id in `audioId`.
      const speech = action as SpeechAction & { audioUrl?: string };
      const file =
        legacyMediaFile(speech.audioUrl, context.legacyId) ??
        legacyMediaFile(speech.audioId, context.legacyId);
      if (!file) continue;
      const assetId = await assetFor(file, false);
      delete speech.audioUrl;
      if (assetId) speech.audioId = assetId;
      else delete speech.audioId;
    }
  }
  return counts;
}

function describeIssues(issues: readonly { path: string; message: string }[]): string {
  const first = issues[0];
  return first ? `${first.path || '/'}: ${first.message}` : 'invalid document';
}

/**
 * Read and validate one classroom file. Answers the document, or the reason it
 * can never be imported.
 */
async function readLegacyClassroom(
  filePath: string,
  legacyId: string,
): Promise<{ document: { stage: Stage; scenes: Scene[] } } | { skip: string }> {
  const raw = await fs.readFile(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { skip: 'not valid JSON' };
  }
  const data = parsed as { stage?: unknown; scenes?: unknown; reserved?: unknown } | null;
  if (!data || typeof data !== 'object') return { skip: 'not a classroom document' };
  // An id a generation run reserved and never completed: there is no
  // classroom behind it.
  if (data.reserved === true) return { skip: 'reservation placeholder' };
  if (!data.stage || typeof data.stage !== 'object' || !Array.isArray(data.scenes)) {
    return { skip: 'missing stage or scenes' };
  }
  // The file name is the id links carry; the document follows it.
  const { currentSceneId: _deviceState, ...stageFields } = data.stage as Stage & {
    currentSceneId?: unknown;
  };
  const stage = { ...stageFields, id: legacyId } as Stage;
  const scenes = (data.scenes as Scene[]).map((scene) => ({ ...scene, stageId: legacyId }));
  const stageCheck = validateAppStage(stage);
  if (!stageCheck.valid) return { skip: `invalid stage (${describeIssues(stageCheck.errors)})` };
  for (const [index, scene] of scenes.entries()) {
    const check = validateAppScene(scene);
    if (!check.valid) {
      return { skip: `invalid scene ${index} (${describeIssues(check.errors)})` };
    }
  }
  return { document: structuredClone({ stage, scenes }) };
}

/**
 * Whether any course holds the id, live or deleted. Only spares allocating the
 * media of a classroom that cannot be created; the create itself is what
 * decides, under its lock.
 */
async function courseIdTaken(queryable: Queryable, stageId: string): Promise<boolean> {
  const result = await queryable.query<{ taken: boolean } & Record<string, unknown>>(
    `SELECT EXISTS(SELECT 1 FROM stage_meta WHERE stage_id = $1)
         OR EXISTS(SELECT 1 FROM document_stages WHERE id = $1) AS taken`,
    [stageId],
  );
  return result.rows[0]?.taken === true;
}

const ID_TAKEN = 'a course with this id already exists';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Import every file-stored classroom in `directory` that the ledger has not
 * settled, one at a time, each through this state machine:
 *
 * 1. Before any media is allocated: an invalid file or a reservation
 *    placeholder, and an id some course already holds, are settled as
 *    `skipped`.
 * 2. The media is allocated and the course created; the `imported` row
 *    commits with it. A create the host refuses (its `authorizeCreate` runs in
 *    the create, where its contract places it) or that finds the id taken
 *    after all is settled as `skipped`.
 * 3. A full asset store is not the classroom's outcome: the run stops there
 *    (`interrupted: 'storage-full'`), writing no row for it or for any later
 *    classroom, so a later run retries once there is room.
 * 4. Any other error is a `failed` attempt, counted in the ledger with its
 *    message; after {@link MAX_IMPORT_ATTEMPTS} the classroom is settled as
 *    skipped ("repeated failure: ...").
 *
 * Whenever a classroom does not end imported, the ids its attempt allocated
 * are released while they are still unclaimed (`releasePending`: pending and
 * named by no document), so a retry never holds two copies of its media, and
 * an entry a course did commit (a lost COMMIT acknowledgement) is never
 * touched.
 *
 * Only one instance runs at a time: a run that cannot take the import lock
 * ends at once (`interrupted: 'lock-busy'`). Logs one summary line when the
 * directory holds any classroom.
 */
export async function importLegacyClassrooms(
  options: ImportLegacyClassroomsOptions = {},
): Promise<LegacyClassroomImportSummary> {
  const directory = options.directory ?? CLASSROOMS_DIR;
  const summary: LegacyClassroomImportSummary = {
    found: 0,
    imported: 0,
    alreadySettled: 0,
    skipped: 0,
    failed: 0,
    mediaStored: 0,
    mediaMissing: 0,
  };

  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summary;
    throw error;
  }
  const legacyIds = entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter(isValidClassroomId)
    .sort();
  summary.found = legacyIds.length;
  if (legacyIds.length === 0) return summary;

  const ownerId = options.ownerId ?? resolveLegacyClassroomOwner();
  const provider = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  const pool = provider.pool as unknown as ConnectableQueryable;
  const queryable = provider.pool as unknown as Queryable;
  const principal = assetPrincipalForOwner(ownerId);

  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [
      IMPORT_LOCK_KEY,
    ]);
    if ((lock.rows[0] as { locked?: boolean } | undefined)?.locked !== true) {
      summary.interrupted = 'lock-busy';
      log.info('Another instance is importing legacy classrooms; this run ends here');
      return summary;
    }
    try {
      const settled = await readSettledLegacyClassroomIds(queryable);

      for (const legacyId of legacyIds) {
        if (options.signal?.aborted) {
          summary.interrupted = 'stopped';
          break;
        }
        if (settled.has(legacyId)) {
          summary.alreadySettled += 1;
          continue;
        }
        const skip = async (detail: string, stageId?: string) => {
          await recordLegacyClassroomImport(queryable, {
            legacyId,
            outcome: 'skipped',
            detail,
            ...(stageId ? { stageId } : {}),
          });
          summary.skipped += 1;
          log.warn(`Legacy classroom ${legacyId} was skipped: ${detail}`);
        };
        const allocations: string[] = [];
        const release = async () => {
          for (const assetId of allocations.splice(0)) {
            try {
              await provider.assetStore.releasePending(principal, assetId);
            } catch (error) {
              // Still pending, so the collector reclaims it once its TTL passes.
              log.warn(
                `Could not release asset ${assetId} of legacy classroom ${legacyId}:`,
                error,
              );
            }
          }
        };

        try {
          const read = await readLegacyClassroom(
            path.join(directory, `${legacyId}.json`),
            legacyId,
          );
          if ('skip' in read) {
            await skip(read.skip);
            continue;
          }
          if (await courseIdTaken(queryable, legacyId)) {
            await skip(ID_TAKEN, legacyId);
            continue;
          }

          const media = await importClassroomMedia(read.document, {
            directory,
            legacyId,
            ownerId,
            allocations,
          });
          await saveCompletedClassroom(
            ownerId,
            { ...read.document, outlines: [] },
            {
              inTransaction: (tx) =>
                recordLegacyClassroomImport(tx, {
                  legacyId,
                  outcome: 'imported',
                  stageId: legacyId,
                  ownerId,
                }),
            },
          );
          summary.mediaStored += media.stored;
          summary.mediaMissing += media.missing;
          summary.imported += 1;
        } catch (error) {
          await release();
          if (error instanceof ImportStorageFullError) {
            summary.interrupted = 'storage-full';
            log.error(
              `The asset store of owner ${ownerId} is full (ASSET_QUOTA_BYTES): the legacy ` +
                `classroom import stopped at ${legacyId} and will be retried later`,
            );
            break;
          }
          if (isStageIdTakenError(error)) {
            await skip(ID_TAKEN, legacyId);
          } else if (isDocumentWriteRefusedError(error) && error.code === CREATE_REFUSED) {
            await skip(`course creation refused: ${error.message}`, legacyId);
          } else {
            const message = errorMessage(error);
            const { attempts, settled: gaveUp } = await recordLegacyClassroomFailure(
              queryable,
              legacyId,
              message,
            );
            if (gaveUp) {
              summary.skipped += 1;
              log.error(
                `Legacy classroom ${legacyId} failed ${attempts} of ${MAX_IMPORT_ATTEMPTS} ` +
                  'attempts and was skipped:',
                error,
              );
            } else {
              summary.failed += 1;
              log.error(
                `Legacy classroom ${legacyId} could not be imported (attempt ${attempts}); ` +
                  'it will be retried:',
                error,
              );
            }
          }
        }
      }
    } finally {
      await lockClient.query('SELECT pg_advisory_unlock($1::bigint)', [IMPORT_LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }

  log.info(
    `Legacy classrooms in ${directory}: ${summary.found} found, ${summary.imported} imported, ` +
      `${summary.alreadySettled} already settled, ${summary.skipped} skipped, ` +
      `${summary.failed} failed (media: ${summary.mediaStored} stored, ` +
      `${summary.mediaMissing} missing) for owner ${ownerId}. ` +
      (isLegacyClassroomImportComplete(summary)
        ? 'Nothing is pending. Keep the directory in place: imported classrooms may still ' +
          'reference files in it.'
        : 'The rest will be retried.'),
  );
  return summary;
}

export interface LegacyClassroomImportSchedule {
  /**
   * Stop retrying. A run in progress ends after the classroom it is on; the
   * promise settles when it has, so the caller can close the pool after it.
   */
  stop(): Promise<void>;
}

/** First retry delay, doubled after every incomplete run up to the ceiling. */
const RETRY_INITIAL_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;

/**
 * Run the import at startup, in the background, until one run is complete
 * ({@link isLegacyClassroomImportComplete}). A run that cannot start (the
 * database is still coming up, say), finds another instance importing, stops
 * at a full asset store, or leaves classrooms failed is retried with
 * exponential backoff, so a deployment whose database was briefly unreachable
 * at boot still imports without a restart. Until a classroom's import lands,
 * its link shows not-found. The timer is unref'd: it never keeps the process
 * alive.
 */
export function startLegacyClassroomImport(
  run: (signal: AbortSignal) => Promise<LegacyClassroomImportSummary> = (signal) =>
    importLegacyClassrooms({ signal }),
): LegacyClassroomImportSchedule {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let delay = RETRY_INITIAL_MS;

  const attempt = async () => {
    timer = undefined;
    let complete = false;
    try {
      complete = isLegacyClassroomImportComplete(await run(controller.signal));
    } catch (error) {
      log.error('The legacy classroom import could not run; it will be retried:', error);
    }
    if (complete || controller.signal.aborted) return;
    log.warn(`Retrying the legacy classroom import in ${Math.round(delay / 1000)}s`);
    timer = setTimeout(() => {
      inFlight = attempt();
    }, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, RETRY_MAX_MS);
  };
  inFlight = attempt();

  return {
    async stop() {
      controller.abort();
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
