/**
 * A legacy shared-partition entry may be deleted by the owner of every course
 * that references it. That check and the delete must be one atomic step: a
 * reference another owner's course adds while the delete is deciding must
 * either be seen by the check or wait for the delete, never slip in between.
 *
 * PGlite has a single connection and cannot interleave two transactions, so
 * this runs against real PostgreSQL (`PG_CONTRACT_URL`), with the competing
 * reference held open in a second connection.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LEGACY_SHARED_ASSET_PRINCIPAL } from '@/lib/persistence/owner-assets';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_owner_assets_legacy_race_test';
const ALICE_COOKIE = '11111111-1111-4111-8111-111111111111';
const BOB_COOKIE = '22222222-2222-4222-8222-222222222222';
const NOW = 1_800_000_000_000;

function courseDocument(stageId: string, assetIds: string[]) {
  return {
    stage: { id: stageId, name: stageId, createdAt: NOW, updatedAt: NOW },
    scenes: assetIds.map((assetId, index) => ({
      id: `scene-${index}`,
      stageId,
      order: index + 1,
      title: `scene-${index}`,
      type: 'slide',
      createdAt: NOW,
      updatedAt: NOW,
      content: {
        type: 'slide',
        canvas: {
          id: `canvas-${index}`,
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
              id: `image-${index}`,
              type: 'image',
              src: assetId,
              left: 0,
              top: 0,
              width: 1,
              height: 1,
            },
          ],
        },
      },
    })),
    outline: {
      outlines: [],
      requirement: stageId,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

describe.skipIf(!contractUrl)('legacy shared-asset mutation under a racing reference', () => {
  let admin: Pool;
  let pool: Pool;
  let databaseUrl: string;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    // A connection string of its own, so the process-wide provider memo gives
    // this file a provider over this schema's pool.
    databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=legacy-race`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE document_asset_refs, document_asset_withdrawals, asset_entries, asset_blobs, ' +
        'stage_meta, document_stages CASCADE',
    );
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function call(cookie: string, path: string, init: RequestInit = {}): Promise<Response> {
    const { handlePersistenceRequest } = await import('@/app/api/persistence/[...path]/route');
    return handlePersistenceRequest(
      new Request(`http://localhost/api/persistence${path}`, {
        ...init,
        headers: { cookie: `anonymous_id=${cookie}`, 'content-type': 'application/json' },
      }),
      { poolFactory: () => pool },
    );
  }

  async function legacyEntry(): Promise<string> {
    const provider = await getServerPersistenceProvider(databaseUrl);
    return provider.assetStore.put(
      { key: LEGACY_SHARED_ASSET_PRINCIPAL },
      new Blob(['legacy-bytes']),
      { contentType: 'image/png' },
    );
  }

  it('refuses the delete when another course references the entry before the check commits', async () => {
    const id = await legacyEntry();
    const aliceCourse = await call(ALICE_COOKIE, '/documents/stage-alice', {
      method: 'PUT',
      body: JSON.stringify(courseDocument('stage-alice', [id])),
    });
    expect(aliceCourse.status).toBeLessThan(300);
    const bobCourse = await call(BOB_COOKIE, '/documents/stage-bob', {
      method: 'PUT',
      body: JSON.stringify(courseDocument('stage-bob', [])),
    });
    expect(bobCourse.status).toBeLessThan(300);

    // Bob's course starts referencing the entry and has not committed yet.
    const racing = await pool.connect();
    try {
      await racing.query('BEGIN');
      await racing.query(
        `INSERT INTO document_asset_refs (stage_id, scope, scene_id, asset_id)
         VALUES ('stage-bob', 'scene', 'scene-0', $1)`,
        [id],
      );

      const deleting = call(ALICE_COOKIE, `/assets/${id}`, { method: 'DELETE' });
      // Let the delete reach its check; with the check under the entry lock it
      // now waits for Bob's transaction.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await racing.query('COMMIT');

      expect((await deleting).status).toBe(204);
    } finally {
      racing.release();
    }

    // Refused: the entry and Bob's reference both survive.
    const entry = await pool.query('SELECT id FROM asset_entries WHERE id = $1', [id]);
    expect(entry.rows).toHaveLength(1);
    const refs = await pool.query(
      'SELECT stage_id FROM document_asset_refs WHERE asset_id = $1 ORDER BY stage_id',
      [id],
    );
    expect(refs.rows).toEqual([{ stage_id: 'stage-alice' }, { stage_id: 'stage-bob' }]);
  });

  it('deletes when the owner of every referencing course asks and nothing races', async () => {
    const id = await legacyEntry();
    await call(ALICE_COOKIE, '/documents/stage-alice', {
      method: 'PUT',
      body: JSON.stringify(courseDocument('stage-alice', [id])),
    });

    const deleted = await call(ALICE_COOKIE, `/assets/${id}`, { method: 'DELETE' });

    expect(deleted.status).toBe(204);
    const entry = await pool.query('SELECT id FROM asset_entries WHERE id = $1', [id]);
    expect(entry.rows).toEqual([]);
  });
});
