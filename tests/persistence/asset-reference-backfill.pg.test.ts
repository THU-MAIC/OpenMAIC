/**
 * The upgrade path: a database that already holds documents and entries, and
 * has never had a reference writer on it.
 *
 * The collector's entry level refuses to run until something has declared that
 * this database's writers maintain references, and until it runs, the one-time
 * backfill does not either. Nothing on a request path answers that question for
 * an idle deployment, so the persistence provider answers it while it
 * initializes. This file is the proof that the answer arrives early enough:
 * legacy rows first, provider second, and the very first collector pass
 * backfills and marks rather than refusing.
 */
import { AssetCollector } from '@openmaic/storage/asset/collector';
import type { Scene, Stage } from '@openmaic/dsl';
import type { MaicDocument } from '@openmaic/storage';
import { PgAssetStore, ensureAssetSchema } from '@openmaic/storage/asset/pg';
import { PgDocumentStore, ensureDocumentSchema } from '@openmaic/storage/document/pg';
import {
  nodePostgresTransaction,
  type ConnectableQueryable,
} from '@openmaic/storage/server/reference';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createAssetByteStore } from '@/lib/persistence/asset-byte-store';
import { ensureStageMetaSchema } from '@/lib/persistence/stage-meta';
import { SHARED_ASSET_PRINCIPAL } from '@/lib/persistence/server-auth';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const contractUrl = process.env.PG_CONTRACT_URL;

/** Its own schema, for the reasons document-asset-references.pg.test.ts gives. */
const TEST_SCHEMA = 'openmaic_asset_backfill_test';

const FIXED_NOW = 1_700_000_000_000;

function documentNaming(stageId: string, assetId: string): MaicDocument<Scene, Stage> {
  return {
    stage: { id: stageId, name: 'Upgraded', createdAt: FIXED_NOW, updatedAt: FIXED_NOW },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        order: 1,
        title: 'scene-1',
        type: 'slide',
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-1',
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
                id: 'image-1',
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
      },
    ],
  } as unknown as MaicDocument<Scene, Stage>;
}

describe.skipIf(!contractUrl)('asset reference backfill on an upgraded database', () => {
  let admin: Pool;
  let pool: Pool;
  let referenced: string;
  let orphaned: string;
  const stageId = 'stage-upgraded';

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const queryable = pool as unknown as ConnectableQueryable;

    // Everything below happens BEFORE the provider exists, which is the whole
    // point: this is what a database upgraded into the lifecycle looks like.
    await ensureDocumentSchema(queryable);
    await ensureStageMetaSchema(queryable);
    await ensureAssetSchema(queryable);

    const withTransaction = nodePostgresTransaction(queryable);
    const assets = new PgAssetStore(queryable, {
      withTransaction,
      byteStore: await createAssetByteStore(undefined, queryable),
    });
    referenced = await assets.put({ key: SHARED_ASSET_PRINCIPAL }, new Blob(['still-named']), {
      contentType: 'image/png',
    });
    orphaned = await assets.put({ key: SHARED_ASSET_PRINCIPAL }, new Blob(['named-by-nobody']), {
      contentType: 'image/png',
    });
    // A pre-lifecycle entry has neither column: no deadline, because allocation
    // did not set one, and no commit, because no write ever committed one.
    // `put` stamps `expires_at` now, so clearing both is what turns these two
    // into the rows an upgraded deployment actually has.
    await pool.query('UPDATE asset_entries SET expires_at = NULL, committed_at = NULL');

    // Saved through a store with tracking OFF -- a pre-upgrade writer. It
    // writes the document and no reference row, and declares nothing.
    const legacyWriter = new PgDocumentStore(queryable, {
      withTransaction,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
    await legacyWriter.saveDocument(documentNaming(stageId, referenced));
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('declares the tracking marker while the provider initializes, and reclaims from the first pass', async () => {
    // Precondition, asserted rather than assumed: legacy rows, no references,
    // and nothing has declared anything.
    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM asset_reference_tracking',
    );
    expect(before.rows[0]?.count).toBe('0');
    const legacy = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM asset_entries
        WHERE committed_at IS NULL AND expires_at IS NULL`,
    );
    expect(legacy.rows[0]?.count).toBe('2');

    await getServerPersistenceProvider(contractUrl!, () => pool);

    // The declaration is part of coming up, not a side effect of the first
    // save. This is the assertion that closes the cold-start window.
    const declared = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM asset_reference_tracking',
    );
    expect(declared.rows[0]?.count).toBe('1');

    const queryable = pool as unknown as ConnectableQueryable;
    const collector = new AssetCollector(
      queryable,
      await createAssetByteStore(undefined, queryable),
      {
        withTransaction: nodePostgresTransaction(queryable),
        documentReferences: true,
      },
    );

    // The first pass. Not throwing is half the assertion: before the
    // declaration this is exactly where the tracking error came from.
    const pass = await collector.collectPass();

    expect(pass.backfilledDocuments).toBe(1);
    expect(pass.legacyEntriesCommitted).toBe(2);
    // Nothing is released on the pass that marks: the stamps are fresh, so
    // both entries still have their whole grace period ahead of them.
    expect(pass.entriesCollected).toBe(0);

    // The walk found the document and re-established what it names, so the
    // entry it names is committed and unstamped.
    const kept = await pool.query<{ committed_at: Date | null; unreferenced_at: Date | null }>(
      'SELECT committed_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [referenced],
    );
    expect(kept.rows[0]?.committed_at).not.toBeNull();
    expect(kept.rows[0]?.unreferenced_at).toBeNull();
    const refs = await pool.query('SELECT asset_id FROM document_asset_refs WHERE stage_id = $1', [
      stageId,
    ]);
    expect(refs.rows).toEqual([{ asset_id: referenced }]);

    // The one no document names is stamped, so it drains after the grace
    // rather than immediately -- an upgrade cannot sweep on its first pass.
    const dropped = await pool.query<{ committed_at: Date | null; unreferenced_at: Date | null }>(
      'SELECT committed_at, unreferenced_at FROM asset_entries WHERE id = $1',
      [orphaned],
    );
    expect(dropped.rows[0]?.committed_at).not.toBeNull();
    expect(dropped.rows[0]?.unreferenced_at).not.toBeNull();
  });
});
