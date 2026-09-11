/**
 * The reference half of the server-owned asset lifecycle, through the app's own
 * stores rather than the package's.
 *
 * Construction-argument assertions would prove the option is passed; they would
 * not prove that a document saved the way this application saves one produces a
 * reference row and commits the allocation it names. That is the property the
 * collector's entry pass depends on, so it is asserted against a real
 * PostgreSQL, on the two write paths this application actually uses: the full
 * save, and the single-scene write the media write-back issues.
 */
import type { Scene, Stage } from '@openmaic/dsl';
import type { MaicDocument } from '@openmaic/storage';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { StageAccessError } from '@/lib/persistence/stage-meta';
import { SHARED_ASSET_PRINCIPAL } from '@/lib/persistence/server-auth';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const FIXED_NOW = 1_700_000_000_000;

const contractUrl = process.env.PG_CONTRACT_URL;
const OWNER = 'anon:11111111-1111-4111-8111-111111111111';

/**
 * Every table this file provisions lives in a schema of its own.
 *
 * The CI job that supplies `PG_CONTRACT_URL` points the storage package's
 * contract suite and the app-domain run at one database, and this file
 * provisions `stage_meta`, whose foreign key to `document_stages` makes the
 * package suite's non-cascading `TRUNCATE document_stages` fail with "cannot
 * truncate a table referenced in a foreign key constraint". Rather than depend
 * on the two running in a particular order, this file puts its own tables
 * somewhere the other suite never looks and drops them afterwards.
 *
 * The search path is this schema and nothing else, deliberately: with `public`
 * on it, `CREATE TABLE IF NOT EXISTS document_stages` would resolve the name to
 * the package suite's table and provision nothing here.
 */
const TEST_SCHEMA = 'openmaic_asset_lifecycle_app_test';

interface EntryLifecycleRow extends Record<string, unknown> {
  committed_at: Date | null;
  expires_at: Date | null;
  unreferenced_at: Date | null;
}

interface ReferenceRow extends Record<string, unknown> {
  stage_id: string;
  scope: string;
  scene_id: string;
  asset_id: string;
}

describe.skipIf(!contractUrl)('document asset references through the app stores', () => {
  let admin: Pool;
  let pool: Pool;
  let allocate: (bytes: string) => Promise<string>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    // Dropped first as well as last: a run killed before its teardown must not
    // hand the next one a half-provisioned schema.
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${TEST_SCHEMA}`,
    });
    // The app's own bootstrap: it is what ensures the asset schema alongside
    // the document schema, and what decides the store options under test.
    const provider = await getServerPersistenceProvider(contractUrl!, () => pool);
    allocate = (bytes: string) =>
      provider.assetStore.put({ key: SHARED_ASSET_PRINCIPAL }, new Blob([bytes]), {
        contentType: 'image/png',
      });
  });

  beforeEach(async () => {
    // Every name here resolves inside the test schema, and every table that
    // references one of them is listed, so the truncation is self-contained.
    await pool.query(
      'TRUNCATE document_asset_refs, asset_entries, asset_blobs, stage_meta, document_stages CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    // `CASCADE` on the schema, not on a table: it drops this file's tables and
    // their foreign keys together and leaves the database as it was found.
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('provisioned its tables in its own schema, not the one the package suite uses', async () => {
    const result = await admin.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = 'document_asset_refs' ORDER BY table_schema`,
      [],
    );
    expect(result.rows.map((row) => row.table_schema)).toContain(TEST_SCHEMA);
  });

  function store() {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId: OWNER,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  /** A structurally valid slide scene whose only media slot names `assetId`. */
  function sceneNaming(stageId: string, sceneId: string, assetId: string): Scene {
    return {
      id: sceneId,
      stageId,
      order: 1,
      title: sceneId,
      type: 'slide',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      content: {
        type: 'slide',
        canvas: {
          id: `canvas-${sceneId}`,
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          theme: {
            backgroundColor: '#ffffff',
            themeColors: ['#2563eb'],
            fontColor: '#111827',
            fontName: 'Inter',
          },
          elements: [
            {
              id: `${sceneId}-image`,
              type: 'image',
              src: assetId,
              left: 0,
              top: 0,
              width: 100,
              height: 100,
            },
          ],
        },
      },
    } as unknown as Scene;
  }

  function documentWith(stageId: string, name: string, scenes: Scene[]) {
    return {
      stage: { id: stageId, name, createdAt: FIXED_NOW, updatedAt: FIXED_NOW },
      scenes,
      outline: {
        outlines: [],
        requirement: name,
        generationComplete: false,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    } as unknown as MaicDocument<Scene, Stage>;
  }

  async function lifecycle(assetId: string): Promise<EntryLifecycleRow> {
    const result = await pool.query<EntryLifecycleRow>(
      'SELECT committed_at, expires_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [assetId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`no entry for ${assetId}`);
    return row;
  }

  /** The exact sum `PgAssetStore` charges the principal's quota against. */
  async function liveQuotaBytes(): Promise<number> {
    const result = await pool.query<{ logical_bytes: string }>(
      `SELECT COALESCE(SUM(blobs.byte_size), 0)::text AS logical_bytes
         FROM asset_entries AS entries
         JOIN asset_blobs AS blobs ON blobs.content_hash = entries.content_hash
        WHERE entries.principal = $1 AND entries.unreferenced_at IS NULL`,
      [SHARED_ASSET_PRINCIPAL],
    );
    return Number(result.rows[0]?.logical_bytes ?? '0');
  }

  async function references(stageId: string): Promise<ReferenceRow[]> {
    const result = await pool.query<ReferenceRow>(
      'SELECT stage_id, scope, scene_id, asset_id FROM document_asset_refs WHERE stage_id = $1',
      [stageId],
    );
    return result.rows;
  }

  it('allocates pending, then commits on the first document write that names the id', async () => {
    const stageId = 'stage-refs-full-save';
    const assetId = await allocate('full-save-bytes');

    // Pending: the bytes are stored and nothing claims them yet, so the entry
    // carries a deadline instead of living forever.
    const allocated = await lifecycle(assetId);
    expect(allocated.committed_at).toBeNull();
    expect(allocated.expires_at).not.toBeNull();
    expect(allocated.unreferenced_at).toBeNull();

    await store().saveDocument(
      documentWith(stageId, 'Full save', [sceneNaming(stageId, 'scene-1', assetId)]),
    );

    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: assetId },
    ]);
    const committed = await lifecycle(assetId);
    expect(committed.committed_at).not.toBeNull();
    expect(committed.expires_at).toBeNull();
    expect(committed.unreferenced_at).toBeNull();
  });

  it('records the reference from the single-scene write the media write-back uses', async () => {
    // Scene granularity is not optional: the media write-back issues `putScene`,
    // so a full-save-only hook would miss the very writes that name new ids.
    const stageId = 'stage-refs-put-scene';
    const assetId = await allocate('write-back-bytes');
    await store().saveDocument(documentWith(stageId, 'Write back', []));
    expect(await references(stageId)).toEqual([]);

    await store().putScene(stageId, sceneNaming(stageId, 'scene-late', assetId));

    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-late', asset_id: assetId },
    ]);
    expect((await lifecycle(assetId)).committed_at).not.toBeNull();
  });

  it('releases a deleted course\u2019s references while the tombstone survives', async () => {
    const stageId = 'stage-refs-deleted';
    const bytes = 'deleted-course-bytes';
    const assetId = await allocate(bytes);
    await store().saveDocument(
      documentWith(stageId, 'Deleted course', [sceneNaming(stageId, 'scene-1', assetId)]),
    );
    expect(await liveQuotaBytes()).toBe(bytes.length);

    await store().deleteDocument(stageId);

    // The two facts this application's deletion has to record at once: the id
    // is retired, and the assets it was holding are free.
    expect(await references(stageId)).toEqual([]);
    const stamped = await lifecycle(assetId);
    expect(stamped.unreferenced_at).not.toBeNull();
    expect(stamped.committed_at).not.toBeNull();
    // The grace period is the undo. Until it elapses the entry is still there
    // and still resolvable; what has changed is that it no longer costs the
    // principal any quota.
    expect(await liveQuotaBytes()).toBe(0);

    // And the tombstone is intact, so the id stays retired: the document rows
    // are deliberately untouched, which is what makes the withdrawal possible
    // in the first place.
    const tombstone = await pool.query<{ deleted_at: Date | null }>(
      `SELECT meta.deleted_at
         FROM stage_meta AS meta
         JOIN document_stages AS stages ON stages.id = meta.stage_id
        WHERE meta.stage_id = $1`,
      [stageId],
    );
    expect(tombstone.rows[0]?.deleted_at).not.toBeNull();
    await expect(
      store().saveDocument(documentWith(stageId, 'Resurrection', [])),
    ).rejects.toBeInstanceOf(StageAccessError);
  });

  it('withdraws nothing a second time, and does not re-stamp what it already released', async () => {
    // A retirement path has to be safe to retry after a crash, and re-stamping
    // would restart the grace period every time someone pressed delete again.
    const stageId = 'stage-refs-deleted-twice';
    const assetId = await allocate('twice-bytes');
    await store().saveDocument(
      documentWith(stageId, 'Twice', [sceneNaming(stageId, 'scene-1', assetId)]),
    );
    await store().deleteDocument(stageId);
    const first = (await lifecycle(assetId)).unreferenced_at;

    await expect(store().deleteDocument(stageId)).resolves.toBeUndefined();

    expect(await references(stageId)).toEqual([]);
    expect((await lifecycle(assetId)).unreferenced_at).toEqual(first);
  });

  it('withdraws nothing for another owner, and leaves their assets alone', async () => {
    const stageId = 'stage-refs-foreign';
    const assetId = await allocate('foreign-bytes');
    await store().saveDocument(
      documentWith(stageId, 'Owned by someone else', [sceneNaming(stageId, 'scene-1', assetId)]),
    );

    const stranger = createOwnerBoundDocumentStore({
      pool,
      ownerId: 'anon:22222222-2222-4222-8222-222222222222',
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await expect(stranger.deleteDocument(stageId)).rejects.toBeInstanceOf(StageAccessError);

    // Refused before anything was written, so the owner's course still holds
    // its reference and still counts against the quota.
    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: assetId },
    ]);
    expect((await lifecycle(assetId)).unreferenced_at).toBeNull();
  });

  it('re-references the assets of a course saved again under the retired id', async () => {
    // The document rows survive the withdrawal, so a write is all it takes to
    // put the references back. Nothing in this application can reach that
    // today -- the id is retired -- but it is the property that makes leaving
    // the rows alone the safe choice rather than a lucky one.
    const stageId = 'stage-refs-resaved';
    const assetId = await allocate('resaved-bytes');
    await store().saveDocument(
      documentWith(stageId, 'Resaved', [sceneNaming(stageId, 'scene-1', assetId)]),
    );
    await store().deleteDocument(stageId);
    expect((await lifecycle(assetId)).unreferenced_at).not.toBeNull();

    await pool.query('UPDATE stage_meta SET deleted_at = NULL WHERE stage_id = $1', [stageId]);
    await store().putScene(stageId, sceneNaming(stageId, 'scene-1', assetId));

    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: assetId },
    ]);
    expect((await lifecycle(assetId)).unreferenced_at).toBeNull();
  });

  it('withdraws the reference and stamps the entry when a scene stops naming the id', async () => {
    // The reclamation that does work today: an edit, a regeneration or a retry
    // that rewrites the slot. The entry loses its last reference row and is
    // stamped, and the collector releases it once the grace period elapses.
    const stageId = 'stage-refs-rewritten';
    const assetId = await allocate('superseded-bytes');
    const replacement = await allocate('replacement-bytes');
    await store().saveDocument(
      documentWith(stageId, 'Rewritten', [sceneNaming(stageId, 'scene-1', assetId)]),
    );

    await store().putScene(stageId, sceneNaming(stageId, 'scene-1', replacement));

    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: replacement },
    ]);
    const stamped = await lifecycle(assetId);
    expect(stamped.unreferenced_at).not.toBeNull();
    expect((await lifecycle(replacement)).unreferenced_at).toBeNull();
  });

  it('is why the document row is never deleted: that loses the claim and keeps the references', async () => {
    // Documentation, as a fact rather than a comment, of the road not taken.
    // Withdrawing references by calling the package's `deleteDocument` looks
    // like the obvious implementation and is wrong twice over, both of which
    // this case exercises against the real schema with a raw delete:
    //
    //  1. `stage_meta` references `document_stages(id) ON DELETE CASCADE`, so
    //     the document row takes the ownership claim -- and therefore any
    //     tombstone on it -- with it. The retired id becomes claimable again.
    //  2. `document_asset_refs` carries NO foreign key to `document_stages`
    //     (the package documents that as the safe direction), so the reference
    //     rows do not go anywhere and the entries stay live.
    //
    // Tombstone gone, references kept: worse in both directions than doing
    // nothing. `withdrawAssetReferences` exists precisely so the release can
    // happen without touching `document_stages`.
    const stageId = 'stage-refs-cascade';
    const assetId = await allocate('cascade-bytes');
    await store().saveDocument(
      documentWith(stageId, 'Cascade', [sceneNaming(stageId, 'scene-1', assetId)]),
    );
    const claimed = await pool.query('SELECT 1 FROM stage_meta WHERE stage_id = $1', [stageId]);
    expect(claimed.rows).toHaveLength(1);

    await pool.query('DELETE FROM document_stages WHERE id = $1', [stageId]);

    const surviving = await pool.query('SELECT 1 FROM stage_meta WHERE stage_id = $1', [stageId]);
    expect(surviving.rows).toEqual([]);
    expect(await references(stageId)).toEqual([
      { stage_id: stageId, scope: 'scene', scene_id: 'scene-1', asset_id: assetId },
    ]);
    expect((await lifecycle(assetId)).unreferenced_at).toBeNull();
  });

  it('records nothing for a slot value the registry never allocated', async () => {
    // Nothing parses an id. A placeholder, a legacy URL and an id from another
    // space are all simply misses, which is the contract's rule for an unknown
    // id, and none of them is an error.
    const stageId = 'stage-refs-unknown';
    await store().saveDocument(
      documentWith(stageId, 'Unknown ids', [
        sceneNaming(stageId, 'scene-1', 'https://example.invalid/legacy.png'),
      ]),
    );

    expect(await references(stageId)).toEqual([]);
  });
});
