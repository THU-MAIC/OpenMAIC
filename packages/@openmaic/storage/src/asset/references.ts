/**
 * Document -> asset reference maintenance.
 *
 * **Internal to the package.** These are transaction-scoped maintenance
 * primitives, not API: called outside a document write they would replace or
 * delete reference rows nothing else knows about. The supported switches are
 * `PgDocumentStoreOptions.trackAssetReferences` and
 * `AssetCollectorOptions.documentReferences`; nothing here is re-exported
 * from the package root.
 *
 * This module is the only place that maintains `document_asset_refs` and the
 * lifecycle columns on `asset_entries` **as part of a document write**. Two
 * other writers exist by design and are named so this docstring cannot go
 * stale: `PgAssetStore.put` writes all three lifecycle columns when it
 * allocates an entry, and `AssetCollector` marks legacy entries and deletes
 * released ones. Everything here takes a `Queryable` and runs inside a
 * transaction the caller already owns -- the document store's write
 * transactions and the collector's backfill -- so a reference row and the
 * document write that implies it commit or roll back together. There is no
 * HTTP route and no scheduled walk over documents.
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
 * A scope is `(stage_id, scope, scene_id)`: `scope = 'stage'` is the
 * stage-level slot -- stage whiteboards and the stage video manifest, which no
 * scene owns -- and `scope = 'scene'` is one scene's own slots. The
 * distinction is a column rather than a reserved `scene_id` value because
 * scene ids are opaque: a scene whose id matched the sentinel would share a
 * key with the stage-level rows, and whichever scope was written second would
 * silently delete the other's rows and stamp its entries unreferenced.
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

/** Which half of a document a reference row belongs to. */
export type DocumentAssetScopeKind = 'stage' | 'scene';

/**
 * The `scene_id` stage-level rows carry. Empty rather than NULL so the primary
 * key covers it (a nullable column would admit the same stage-level reference
 * twice); it is not a reserved value, because `scope` is what distinguishes
 * the two halves.
 */
const STAGE_SCOPE_SCENE_ID = '';

/** One reference scope of one stage: which rows to replace, and with what. */
export interface DocumentAssetScope {
  readonly scope: DocumentAssetScopeKind;
  /** The scene these candidates belong to; `''` on a stage-level scope. */
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
 * Keep only the members a slot enumerator can dereference.
 *
 * `slideMediaSlotDescriptors` reads `element.type` and the manifest reads
 * `action.type`, so a `null` (or primitive) member throws a raw `TypeError`
 * mid-enumeration. That matters because nothing rejects such a document:
 * `validateScene` never inspects `canvas.elements`, so `elements: [null]` is
 * storable through the ordinary write path and may already be on disk. Left
 * unfiltered it would fail the document write that names an asset and, worse,
 * stall the backfill on the same row forever -- which blocks the entry level
 * for the whole deployment. Dropping an unreadable member cannot lose a
 * reference, because a member that is not an object holds none.
 */
function enumerableMembers(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.filter((member) => typeof member === 'object' && member !== null);
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
    elements: enumerableMembers(value.elements),
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
    whiteboards: enumerableMembers(scene.whiteboards).map(scopedSlide),
    actions: enumerableMembers(scene.actions),
  } as unknown as ScopedScene;
}

function scopedStage(row: unknown): ScopedStage {
  if (typeof row !== 'object' || row === null) return NO_STAGE_SLOTS;
  const stage = row as { whiteboard?: unknown; videoManifest?: unknown };
  return {
    whiteboard: enumerableMembers(stage.whiteboard).map(scopedSlide) as Stage['whiteboard'],
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
    scope: 'stage',
    sceneId: STAGE_SCOPE_SCENE_ID,
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
  return {
    scope: 'scene',
    sceneId,
    candidates: scoped === null ? [] : refsOf(NO_STAGE_SLOTS, [scoped]),
  };
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
  scope?: DocumentAssetScope,
): Promise<string[]> {
  const result =
    scope === undefined
      ? await queryable.query<{ asset_id: string }>(
          'SELECT DISTINCT asset_id FROM document_asset_refs WHERE stage_id = $1',
          [stageId],
        )
      : await queryable.query<{ asset_id: string }>(
          `SELECT asset_id
             FROM document_asset_refs
            WHERE stage_id = $1 AND scope = $2 AND scene_id = $3`,
          [stageId, scope.scope, scope.sceneId],
        );
  return result.rows.map((row) => row.asset_id);
}

/**
 * Record that a document store on this database maintains reference rows.
 *
 * Written by every reference-maintaining transaction, so the marker appears as
 * a side effect of the first such write and cannot be claimed by a store that
 * was configured and then never used. The collector refuses its entry pass
 * without it, because an empty `document_asset_refs` cannot be told apart from
 * documents that reference nothing, while the absence of this row can.
 *
 * A host that knows every writer on this database tracks references can also
 * write it deliberately at startup, rather than waiting for a first write
 * that may be days away on a quiet deployment -- see
 * `PgDocumentStore.declareAssetReferenceTracking`, which is the only caller
 * that is not itself maintaining references.
 */
export async function recordAssetReferenceTracking(queryable: Queryable): Promise<void> {
  await queryable.query(
    `INSERT INTO asset_reference_tracking (singleton, enabled_at)
     VALUES (TRUE, now())
     ON CONFLICT DO NOTHING`,
  );
}

/**
 * Commit every entry the given scope of this stage now references.
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
  scope: DocumentAssetScope,
): Promise<void> {
  await queryable.query(
    `UPDATE asset_entries
        SET committed_at = COALESCE(committed_at, now()),
            expires_at = NULL,
            unreferenced_at = NULL
      WHERE id IN (
              SELECT asset_id
                FROM document_asset_refs
               WHERE stage_id = $1 AND scope = $2 AND scene_id = $3
            )`,
    [stageId, scope.scope, scope.sceneId],
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
  scope: DocumentAssetScope,
): Promise<void> {
  await queryable.query(
    `DELETE FROM document_asset_refs
      WHERE stage_id = $1 AND scope = $2 AND scene_id = $3`,
    [stageId, scope.scope, scope.sceneId],
  );
  await insertScopeRows(queryable, stageId, scope);
}

async function insertScopeRows(
  queryable: Queryable,
  stageId: string,
  scope: DocumentAssetScope,
): Promise<void> {
  const ids = queryableCandidates(scope.candidates);
  if (ids.length === 0) return;
  // The join is what keeps ids opaque: a candidate with no entry contributes
  // no row and no error. Bytes are stored before any document can name the id
  // they were stored under, so this join loses nothing a document really
  // holds.
  await queryable.query(
    `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
     SELECT $1, $2, $3, entries.id
       FROM asset_entries AS entries
      WHERE entries.id = ANY($4::text[])
     ON CONFLICT DO NOTHING`,
    [stageId, scope.scope, scope.sceneId, ids],
  );
}

/** One scope of one stage to replace. */
export interface SyncDocumentAssetReferencesInput {
  readonly stageId: string;
  readonly scope: DocumentAssetScope;
}

/**
 * Replace one scope's reference rows and stamp the entries it affected.
 *
 * Exactly the rows of `(stageId, scope, sceneId)` change. A scene's write
 * cannot disturb another scene's rows -- or the stage-level rows, whatever the
 * scene is called -- which is what lets the incremental write paths maintain
 * references correctly without re-reading the whole document.
 */
export async function syncDocumentAssetReferences(
  queryable: Queryable,
  input: SyncDocumentAssetReferencesInput,
): Promise<void> {
  const { stageId, scope } = input;
  const previous = await referencedAssetIds(queryable, stageId, scope);
  await recordAssetReferenceTracking(queryable);
  await forgetDocumentAssetWithdrawal(queryable, stageId);
  await replaceScopeRows(queryable, stageId, scope);
  await commitReferencedEntries(queryable, stageId, scope);
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
 * simply contribute no scope, so their rows do not come back. Rows are
 * inserted for every scope before any entry is committed, so two scopes naming
 * the same id cannot have one of them stamp it unreferenced.
 */
export async function syncStageAssetReferences(
  queryable: Queryable,
  input: SyncStageAssetReferencesInput,
): Promise<void> {
  const { stageId, scopes } = input;
  const previous = await referencedAssetIds(queryable, stageId);
  await recordAssetReferenceTracking(queryable);
  await forgetDocumentAssetWithdrawal(queryable, stageId);
  await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1', [stageId]);
  for (const scope of scopes) {
    await insertScopeRows(queryable, stageId, scope);
  }
  for (const scope of scopes) {
    await commitReferencedEntries(queryable, stageId, scope);
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
  const scope: DocumentAssetScope | undefined =
    sceneId === undefined ? undefined : { scope: 'scene', sceneId, candidates: [] };
  const previous = await referencedAssetIds(queryable, stageId, scope);
  await recordAssetReferenceTracking(queryable);
  if (scope === undefined) {
    await queryable.query('DELETE FROM document_asset_refs WHERE stage_id = $1', [stageId]);
  } else {
    await queryable.query(
      `DELETE FROM document_asset_refs
        WHERE stage_id = $1 AND scope = $2 AND scene_id = $3`,
      [stageId, scope.scope, scope.sceneId],
    );
  }
  await stampUnreferencedEntries(queryable, previous);
}

/**
 * Insert the reference rows of one scope without removing anything, and
 * without touching a lifecycle column or the tracking marker.
 *
 * The collector's backfill only ever adds, which is what makes a partial walk
 * safe: an interrupted backfill leaves the reference table a subset of the
 * truth, never a superset, and the entries it would have covered stay legacy
 * (and therefore uncollectable) until a walk finishes. The caller is
 * responsible for reading the document inside the same transaction as this
 * insert -- see `AssetCollector.backfillChunk` -- or a concurrent write could
 * make these rows a superset after all.
 *
 * It references whatever the document names, **including an entry that is
 * already stamped**, and that is deliberate. While the walk is behind, a stamp
 * carries no information about the documents it has not reached: an unwalked
 * pre-tracking document has no reference rows by definition, so an entry it
 * names looks unreferenced to every other writer, and any write that drops
 * that entry elsewhere stamps it. Refusing to re-reference a stamped entry
 * here would therefore delete a live document's media -- the walk would leave
 * it with no row and the entry pass would take it. Re-referencing is the safe
 * direction: `releaseEntries` skips a referenced entry, and if the document
 * later drops it for real, the stamp it already carries is past grace and it
 * goes on the next pass.
 *
 * A document that was RETIRED with its rows kept is the case that needs an
 * answer, and it gets one from {@link recordDocumentAssetWithdrawal} -- a
 * record of the retirement itself, which is a fact about the document rather
 * than an inference from an entry's columns.
 */
export async function backfillDocumentAssetReferences(
  queryable: Queryable,
  input: SyncDocumentAssetReferencesInput,
): Promise<void> {
  await insertScopeRows(queryable, input.stageId, input.scope);
}

/**
 * Record that a document has been retired with its rows kept, so the
 * collector's backfill leaves its stored JSON alone.
 *
 * The reference table alone cannot express this. A retired document is
 * byte-identical to a live one that happens to reference nothing -- which is
 * deliberate, since the retirement is the host's tombstone and not this
 * schema's business -- so a walk reading only the documents would re-reference
 * what the retirement released. This record is the only thing that can tell
 * the two apart, and it is the ONLY reason the walk ever skips a document that
 * still has a row in `document_stages`. Inferring it from an entry's
 * `unreferenced_at` instead was tried and is wrong: while the walk is behind,
 * a stamped entry may simply be one that an unwalked live document names, and
 * skipping it there deletes that document's media.
 */
export async function recordDocumentAssetWithdrawal(
  queryable: Queryable,
  stageId: string,
): Promise<void> {
  await queryable.query(
    `INSERT INTO document_asset_withdrawals (stage_id, withdrawn_at)
     VALUES ($1, now())
     ON CONFLICT (stage_id) DO NOTHING`,
    [stageId],
  );
}

/** True when this document was retired with its rows kept and not written since. */
export async function documentAssetReferencesWithdrawn(
  queryable: Queryable,
  stageId: string,
): Promise<boolean> {
  const result = await queryable.query(
    'SELECT 1 FROM document_asset_withdrawals WHERE stage_id = $1',
    [stageId],
  );
  return result.rows.length > 0;
}

/**
 * Forget a withdrawal, because the document's references are being
 * re-established.
 *
 * A host that un-retires a course writes it again, and that write is the
 * authority on what the document holds: from then on the backfill may read it
 * like any other. Called from the sync paths, so no write path can
 * re-reference a document and leave it marked withdrawn, and from
 * `deleteDocument`, so a record cannot outlive the document it describes and
 * be inherited by whatever later claims that id.
 */
export async function forgetDocumentAssetWithdrawal(
  queryable: Queryable,
  stageId: string,
): Promise<void> {
  await queryable.query('DELETE FROM document_asset_withdrawals WHERE stage_id = $1', [stageId]);
}

/** True when some document store on this database maintains reference rows. */
export async function assetReferenceTrackingEnabled(queryable: Queryable): Promise<boolean> {
  const result = await queryable.query('SELECT 1 FROM asset_reference_tracking LIMIT 1');
  return result.rows.length > 0;
}
