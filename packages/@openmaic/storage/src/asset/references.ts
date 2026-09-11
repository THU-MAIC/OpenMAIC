/**
 * Document -> asset reference maintenance.
 *
 * This module is the ONLY code that writes `document_asset_refs` or the
 * lifecycle columns on `asset_entries`. Everything here takes a `Queryable`
 * and runs inside a transaction the caller already owns -- the document
 * store's write transactions and the collector's backfill -- so a reference
 * row and the document write that implies it commit or roll back together.
 * There is no HTTP route and no scheduled walk over documents.
 *
 * Two halves, deliberately separated:
 *
 * - The **pure** half turns a document, a single scene, or a stage into the
 *   candidate references of one scope, using the DSL's own enumerator. It is
 *   the same enumeration exports use, so a slot the DSL learns about arrives
 *   here for free.
 * - The **SQL** half replaces the rows of one scope and stamps the lifecycle
 *   columns of the entries that gained or lost their last reference.
 *
 * A scope is `(stage_id, scene_id)`, where `scene_id = ''` is the stage-level
 * slot -- stage whiteboards and the stage video manifest, which no scene owns.
 * Scopes match the granularity of the document store's writes: `putScene`
 * touches one scene's rows, `putStage` the stage-level rows, a full save all
 * of them. That is not a detail: the media write-back path writes scenes and
 * stages incrementally, so a full-save-only hook would miss exactly the writes
 * that name freshly allocated ids.
 *
 * **Ids are opaque.** A candidate becomes a row only when `asset_entries`
 * already holds an entry with that id, established by a join in the caller's
 * transaction. Nothing here parses, validates, or prefix-matches a reference:
 * placeholders, `data:` payloads, legacy URLs and ids from other id spaces
 * simply produce no row, which is the same rule the read paths apply when they
 * answer "unknown id" with a miss.
 */
import type { Action, Scene, SceneType, Slide, SlideContent, Stage } from '@openmaic/dsl';
import { enumerateAssetManifest, isSlideContent } from '@openmaic/dsl';
import { isLosslessJsonString } from '../runtime/json-value.js';
import type { Queryable } from '../runtime/pg.js';

export type { Queryable } from '../runtime/pg.js';

/**
 * The `scene_id` of the stage-level scope. Empty rather than NULL so the
 * primary key covers it: a nullable column would let the same stage-level
 * reference be inserted twice.
 */
export const STAGE_ASSET_SCOPE_SCENE_ID = '';

/** One reference scope of one stage: which rows to replace, and with what. */
export interface DocumentAssetScope {
  /** The scene these candidates belong to, or `''` for the stage-level slot. */
  readonly sceneId: string;
  /** References the document holds in this scope, exactly as it holds them. */
  readonly candidates: readonly string[];
}

/**
 * The document slice the scope helpers read.
 *
 * Both members are `unknown` on purpose. The document store is generic over
 * scene and stage shapes an app may widen, and the collector's backfill reads
 * raw JSONB written by older code; neither can promise the DSL's exact types.
 * The helpers below therefore prove the shape they need and enumerate what
 * they find, which is also the conservative direction -- an unrecognized shape
 * yields no candidates, and a candidate that no longer exists as an entry
 * yields no row.
 */
export interface ScopedDocumentInput {
  readonly stage: unknown;
  /** Scene rows, each carrying the id the row is stored under. */
  readonly scenes: readonly { readonly id: string }[];
}

type ScopedScene = Scene<Action, { type: SceneType }>;
type ScopedStage = Pick<Stage, 'whiteboard' | 'videoManifest'>;

/**
 * The empty stage, used to ask the DSL enumerator for one scene at a time.
 *
 * `enumerateAssetManifest` reports one flat reference set for a whole
 * document, so it cannot say which scene a reference came from. Running it
 * over a one-scene document, and separately over a scene-less stage, recovers
 * exactly that attribution without restating any slot definition here -- the
 * slots stay the DSL's to own, so a slot it learns about arrives here for
 * free.
 */
const NO_STAGE_SLOTS: ScopedStage = {};

function refsOf(stage: ScopedStage, scenes: readonly ScopedScene[]): string[] {
  const { entries } = enumerateAssetManifest({ stage, scenes });
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    // One ref can appear under several kinds (a video's `src` and `mediaRef`);
    // the reference table records the id once per scope.
    if (seen.has(entry.ref)) continue;
    seen.add(entry.ref);
    refs.push(entry.ref);
  }
  return refs;
}

/**
 * Normalize one slide for the enumerator.
 *
 * `slideMediaSlotDescriptors` reads `slide.elements.length`, so a row that
 * stored a slide without an `elements` array would throw mid-walk.
 * Substituting an empty array cannot lose a reference such a row does not
 * hold.
 */
function scopedSlide(slide: unknown): Slide {
  const value = (typeof slide === 'object' && slide !== null ? slide : {}) as Record<
    string,
    unknown
  >;
  return {
    ...value,
    elements: Array.isArray(value.elements) ? value.elements : [],
  } as unknown as Slide;
}

function scopedScene(row: unknown): ScopedScene | null {
  if (typeof row !== 'object' || row === null) return null;
  const scene = row as Record<string, unknown>;
  if (typeof scene.content !== 'object' || scene.content === null) return null;
  const storedContent = scene.content as { type: SceneType };
  return {
    ...scene,
    content: isSlideContent(storedContent)
      ? { ...storedContent, canvas: scopedSlide((storedContent as SlideContent).canvas) }
      : storedContent,
    whiteboards: Array.isArray(scene.whiteboards) ? scene.whiteboards.map(scopedSlide) : [],
    actions: Array.isArray(scene.actions) ? scene.actions : [],
  } as unknown as ScopedScene;
}

function scopedStage(row: unknown): ScopedStage {
  if (typeof row !== 'object' || row === null) return NO_STAGE_SLOTS;
  const stage = row as { whiteboard?: unknown; videoManifest?: unknown };
  return {
    whiteboard: (Array.isArray(stage.whiteboard)
      ? stage.whiteboard.map(scopedSlide)
      : []) as Stage['whiteboard'],
    videoManifest:
      typeof stage.videoManifest === 'object' && stage.videoManifest !== null
        ? (stage.videoManifest as Stage['videoManifest'])
        : {},
  };
}

/**
 * The stage-level scope: stage whiteboards and the stage video manifest.
 *
 * The video manifest's keys are enumerated even though the manifest is an
 * index rather than a byte owner, and they land here rather than on any scene
 * because the manifest is stage-level and names no scene. Over-attributing a
 * reference to the stage is the safe direction: it keeps alive an entry
 * something in the document still names, where losing the row would let the
 * collector take it.
 */
export function stageAssetScope(stage: unknown): DocumentAssetScope {
  return {
    sceneId: STAGE_ASSET_SCOPE_SCENE_ID,
    candidates: refsOf(scopedStage(stage), []),
  };
}

/**
 * One scene's scope: its canvas, its whiteboards, and its speech audio.
 *
 * `sceneId` is passed separately because it is the id the row is stored
 * under -- the key the reference rows must agree with -- rather than whatever
 * the payload happens to carry.
 */
export function sceneAssetScope(sceneId: string, scene: unknown): DocumentAssetScope {
  const scoped = scopedScene(scene);
  return { sceneId, candidates: scoped === null ? [] : refsOf(NO_STAGE_SLOTS, [scoped]) };
}

/** Every scope of one document: the stage-level slot plus one per scene. */
export function documentAssetScopes(document: ScopedDocumentInput): DocumentAssetScope[] {
  return [
    stageAssetScope(document.stage),
    ...document.scenes.map((scene) => sceneAssetScope(scene.id, scene)),
  ];
}

/**
 * Candidates Postgres can carry as text parameters.
 *
 * This is an encoding guard, not a check on the id domain: a NUL code point or
 * an unpaired surrogate is rejected by `text` and `jsonb` alike, so such a
 * value could not have reached a stored document in the first place, and
 * passing one down would fail the whole write transaction rather than lose one
 * reference. Ids themselves stay entirely unconstrained.
 */
function queryableCandidates(candidates: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !isLosslessJsonString(candidate)) continue;
    unique.add(candidate);
  }
  return [...unique];
}

async function referencedAssetIds(
  queryable: Queryable,
  stageId: string,
  sceneId?: string,
): Promise<string[]> {
  const result =
    sceneId === undefined
      ? await queryable.query<{ asset_id: string }>(
          'SELECT DISTINCT asset_id FROM document_asset_refs WHERE stage_id = $1',
          [stageId],
        )
      : await queryable.query<{ asset_id: string }>(
          'SELECT asset_id FROM document_asset_refs WHERE stage_id = $1 AND scene_id = $2',
          [stageId, sceneId],
        );
  return result.rows.map((row) => row.asset_id);
}

/**
 * Commit every entry the given scopes of this stage now reference.
 *
 * `COALESCE(committed_at, now())` keeps the first document write's timestamp:
 * commit is "a document has named this id", which happens once. Clearing
 * `expires_at` retires the pending deadline, and clearing `unreferenced_at`
 * un-stamps an entry that a write is putting back -- an undo, a restore, or a
 * slower tab writing the same id back inside the grace period, all of which
 * are just a reference arriving again.
 */
async function commitReferencedEntries(
  queryable: Queryable,
  stageId: string,
  sceneId: string,
): Promise<void> {
  await queryable.query(
    `UPDATE asset_entries
        SET committed_at = COALESCE(committed_at, now()),
            expires_at = NULL,
            unreferenced_at = NULL
      WHERE id IN (
              SELECT asset_id
                FROM document_asset_refs
               WHERE stage_id = $1 AND scene_id = $2
            )`,
    [stageId, sceneId],
  );
}

/**
 * Stamp the entries among `previous` that no document references any more.
 *
 * "Any more" is global, not scoped: another scene of this stage, or another
 * stage entirely, keeping a row is enough to leave the entry alone. The
 * `unreferenced_at IS NULL` guard makes the stamp the moment the LAST
 * reference went, so a document rewritten repeatedly cannot keep pushing an
 * entry's grace period out.
 */
async function stampUnreferencedEntries(
  queryable: Queryable,
  previous: readonly string[],
): Promise<void> {
  const ids = queryableCandidates(previous);
  if (ids.length === 0) return;
  await queryable.query(
    `UPDATE asset_entries AS entries
        SET unreferenced_at = now()
      WHERE entries.id = ANY($1::text[])
        AND entries.unreferenced_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM document_asset_refs AS refs WHERE refs.asset_id = entries.id
            )`,
    [ids],
  );
}

async function replaceScopeRows(
  queryable: Queryable,
  stageId: string,
  sceneId: string,
  candidates: readonly string[],
): Promise<void> {
  await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1 AND scene_id = $2', [
    stageId,
    sceneId,
  ]);
  const ids = queryableCandidates(candidates);
  if (ids.length === 0) return;
  // The join is what keeps ids opaque: a candidate with no entry contributes
  // no row and no error. Bytes are stored before any document can name the id
  // they were stored under, so this join loses nothing a document really
  // holds.
  await queryable.query(
    `INSERT INTO document_asset_refs (stage_id, scene_id, asset_id)
     SELECT $1, $2, entries.id
       FROM asset_entries AS entries
      WHERE entries.id = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [stageId, sceneId, ids],
  );
}

/** What scope to replace, and with which candidate references. */
export interface SyncDocumentAssetReferencesInput {
  readonly stageId: string;
  /** `''` for the stage-level scope. */
  readonly sceneId: string;
  readonly candidates: readonly string[];
}

/**
 * Replace one scope's reference rows and stamp the entries it affected.
 *
 * Exactly the rows of `(stageId, sceneId)` change. A scene's write cannot
 * disturb another scene's rows, which is what lets the incremental write paths
 * maintain references correctly without re-reading the whole document.
 */
export async function syncDocumentAssetReferences(
  queryable: Queryable,
  input: SyncDocumentAssetReferencesInput,
): Promise<void> {
  const { stageId, sceneId, candidates } = input;
  const previous = await referencedAssetIds(queryable, stageId, sceneId);
  await replaceScopeRows(queryable, stageId, sceneId, candidates);
  await commitReferencedEntries(queryable, stageId, sceneId);
  await stampUnreferencedEntries(queryable, previous);
}

/** Every scope of one stage, for a write that replaces the whole document. */
export interface SyncStageAssetReferencesInput {
  readonly stageId: string;
  readonly scopes: readonly DocumentAssetScope[];
}

/**
 * Replace every reference row of one stage: the full-save counterpart of
 * {@link syncDocumentAssetReferences}.
 *
 * Deleting the stage's rows and re-inserting from the scopes is what makes a
 * full save authoritative, including for scenes the save removed -- those
 * simply contribute no scope, so their rows do not come back.
 */
export async function syncStageAssetReferences(
  queryable: Queryable,
  input: SyncStageAssetReferencesInput,
): Promise<void> {
  const { stageId, scopes } = input;
  const previous = await referencedAssetIds(queryable, stageId);
  await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1', [stageId]);
  for (const scope of scopes) {
    await replaceScopeRows(queryable, stageId, scope.sceneId, scope.candidates);
  }
  for (const scope of scopes) {
    await commitReferencedEntries(queryable, stageId, scope.sceneId);
  }
  await stampUnreferencedEntries(queryable, previous);
}

/** Which rows to drop: one scene's, or every row of the stage. */
export interface RemoveDocumentAssetReferencesInput {
  readonly stageId: string;
  /** Omit to remove every scope of the stage, stage-level rows included. */
  readonly sceneId?: string;
}

/**
 * Drop a scope's reference rows and stamp the entries that lost their last
 * reference.
 *
 * This is the deletion counterpart: a removed scene, or a deleted document,
 * releases what it held and the entries drain after the collector's grace
 * period rather than immediately -- which is what makes an undo, a
 * restore-from-export, or a re-save inside that window a no-op rather than a
 * loss.
 */
export async function removeDocumentAssetReferences(
  queryable: Queryable,
  input: RemoveDocumentAssetReferencesInput,
): Promise<void> {
  const { stageId, sceneId } = input;
  const previous = await referencedAssetIds(queryable, stageId, sceneId);
  if (sceneId === undefined) {
    await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1', [stageId]);
  } else {
    await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1 AND scene_id = $2', [
      stageId,
      sceneId,
    ]);
  }
  await stampUnreferencedEntries(queryable, previous);
}

/**
 * Insert the reference rows of one scope without removing anything, and
 * without touching a lifecycle column.
 *
 * The collector's backfill only ever adds, which is what makes a partial walk
 * safe: an interrupted backfill leaves the reference table a subset of the
 * truth, never a superset, and the entries it would have covered stay legacy
 * (and therefore uncollectable) until a walk finishes.
 */
export async function backfillDocumentAssetReferences(
  queryable: Queryable,
  input: SyncDocumentAssetReferencesInput,
): Promise<void> {
  const ids = queryableCandidates(input.candidates);
  if (ids.length === 0) return;
  await queryable.query(
    `INSERT INTO document_asset_refs (stage_id, scene_id, asset_id)
     SELECT $1, $2, entries.id
       FROM asset_entries AS entries
      WHERE entries.id = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [input.stageId, input.sceneId, ids],
  );
}
