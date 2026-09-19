import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type Queryable,
  type WithTransaction,
} from '../src/document/pg.js';
import type { MaicDocument, StageFreshnessManifest } from '../src/document/types.js';
import {
  acquireDocumentPgContractLock,
  truncateDocumentTables,
} from './pg-document-contract-helpers.js';
import { slideScene } from './document-contract.js';

const contractUrl = process.env.PG_CONTRACT_URL;

if (process.env.STORAGE_PG_CONTRACT_REQUIRED === '1' && !contractUrl) {
  throw new Error(
    '@openmaic/storage: STORAGE_PG_CONTRACT_REQUIRED=1 requires PG_CONTRACT_URL; ' +
      'refusing to skip the PostgreSQL contract suite',
  );
}

function transactionFor(pool: Pool): WithTransaction {
  return async (body) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client as Queryable);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the transaction body's original error.
      }
      throw error;
    } finally {
      client.release();
    }
  };
}

const OWNER = 'owner-1';

/** A document whose scenes are exactly the given ids, in the given orders. */
function makeDoc(stageId: string, scenes: { id: string; order: number }[]): MaicDocument {
  return {
    stage: { id: stageId, name: 'Course', createdAt: 1000, updatedAt: 2000 },
    scenes: scenes.map((scene) => slideScene(stageId, scene.id, scene.order)),
    outline: { entries: [{ id: 'o1', title: 'Intro' }], generationComplete: true },
  };
}

/** The manifest row for one scene, straight from the companion table. */
async function sceneRev(pool: Pool, stageId: string, sceneId: string): Promise<number> {
  const result = await pool.query<{ rev: number | string }>(
    'SELECT rev FROM document_scene_revision WHERE stage_id = $1 AND scene_id = $2',
    [stageId, sceneId],
  );
  return result.rows[0] === undefined ? 0 : Number(result.rows[0].rev);
}

async function stageRev(pool: Pool, stageId: string): Promise<number> {
  const result = await pool.query<{ rev: number | string }>(
    'SELECT rev FROM document_stage_revision WHERE stage_id = $1',
    [stageId],
  );
  return result.rows[0] === undefined ? 0 : Number(result.rows[0].rev);
}

describe.skipIf(!contractUrl)('per-scene monotonic revisions (freshness)', () => {
  let pool: Pool;
  let ownerStore: PgDocumentStore;
  let releaseContractLock: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    pool = new Pool({ connectionString: contractUrl, max: 16 });
    // Same shared-database lock as the document-store suite: both suites
    // provision the same document schema (functions and triggers included),
    // so they must never run at the same time.
    releaseContractLock = await acquireDocumentPgContractLock(pool);
    await ensureDocumentSchema(pool as Queryable);
  }, 60_000);

  beforeEach(async () => {
    await truncateDocumentTables(pool as Queryable);
    ownerStore = new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
    }).forOwner(OWNER);
  });

  afterAll(async () => {
    await releaseContractLock?.();
    await pool.end();
  });

  const readManifest = (stageId: string): Promise<StageFreshnessManifest | null> =>
    ownerStore.readFreshnessManifest(stageId);

  it('HTTP route write (saveDocument) bumps the scene revisions of the stage and nothing else', async () => {
    const stageId = 'http-route-stage';
    const otherStage = 'http-route-other';
    await ownerStore.saveDocument(
      makeDoc(stageId, [
        { id: 's1', order: 1 },
        { id: 's2', order: 2 },
      ]),
    );
    await ownerStore.saveDocument(makeDoc(otherStage, [{ id: 'x1', order: 1 }]));

    expect(await readManifest(stageId)).toEqual({
      rev: 3,
      scenes: [
        { id: 's1', order: 1, rev: 1 },
        { id: 's2', order: 2, rev: 1 },
      ],
    });

    // A second coarse save rewrites every scene row of this stage, so every
    // scene's revision strictly increases...
    await ownerStore.saveDocument(
      makeDoc(stageId, [
        { id: 's1', order: 3 },
        { id: 's2', order: 2 },
      ]),
    );
    const second = (await readManifest(stageId))!;
    expect(second.rev).toBe(6);
    expect(second.scenes.find((scene) => scene.id === 's1')!.rev).toBe(2);
    expect(second.scenes.find((scene) => scene.id === 's2')!.rev).toBe(2);

    // ...while an unrelated stage's revisions are untouched.
    expect(await readManifest(otherStage)).toEqual({
      rev: 2,
      scenes: [{ id: 'x1', order: 1, rev: 1 }],
    });
  });

  it('HTTP route rename (putStage) bumps the stage revision but no scene revision', async () => {
    const stageId = 'http-route-rename';
    await ownerStore.saveDocument(makeDoc(stageId, [{ id: 's1', order: 1 }]));
    const before = (await readManifest(stageId))!;
    expect(before).toEqual({ rev: 2, scenes: [{ id: 's1', order: 1, rev: 1 }] });

    await ownerStore.putStage(stageId, {
      id: stageId,
      name: 'Renamed',
      createdAt: 1000,
      updatedAt: 3000,
    });
    const after = (await readManifest(stageId))!;
    expect(after.rev).toBe(3);
    expect(after.scenes).toEqual([{ id: 's1', order: 1, rev: 1 }]);
  });

  it('owner-scoped store write as agent tools use (putScene) bumps only the touched scene', async () => {
    const stageId = 'agent-put-scene';
    await ownerStore.saveDocument(
      makeDoc(stageId, [
        { id: 's1', order: 1 },
        { id: 's2', order: 2 },
      ]),
    );
    expect(await sceneRev(pool, stageId, 's1')).toBe(1);
    expect(await sceneRev(pool, stageId, 's2')).toBe(1);
    expect(await stageRev(pool, stageId)).toBe(3);

    // The generation tools edit one page at a time via putScene.
    await ownerStore.putScene(stageId, slideScene(stageId, 's1', 4));

    expect(await sceneRev(pool, stageId, 's1')).toBe(2);
    expect(await sceneRev(pool, stageId, 's2')).toBe(1);
    expect(await stageRev(pool, stageId)).toBe(4);

    // A brand-new scene starts at revision 1; siblings stay put.
    await ownerStore.putScene(stageId, slideScene(stageId, 's3', 3));
    expect(await sceneRev(pool, stageId, 's3')).toBe(1);
    expect(await sceneRev(pool, stageId, 's1')).toBe(2);
    expect(await stageRev(pool, stageId)).toBe(5);
  });

  it('direct SQL UPDATE bumps the touched scene via the trigger, without the store', async () => {
    const stageId = 'direct-sql';
    await ownerStore.saveDocument(
      makeDoc(stageId, [
        { id: 's1', order: 1 },
        { id: 's2', order: 2 },
      ]),
    );
    expect(await sceneRev(pool, stageId, 's1')).toBe(1);

    // A manual or batch writer that bypasses the store entirely.
    await pool.query(
      'UPDATE document_scenes SET scene_order = $3 WHERE stage_id = $1 AND id = $2',
      [stageId, 's1', 9],
    );
    expect(await sceneRev(pool, stageId, 's1')).toBe(2);
    expect(await sceneRev(pool, stageId, 's2')).toBe(1);
    expect(await stageRev(pool, stageId)).toBe(4);

    // A direct stage write bumps the stage revision and leaves scenes alone.
    await pool.query('UPDATE document_stages SET name = $2 WHERE id = $1', [stageId, 'Manual']);
    expect(await stageRev(pool, stageId)).toBe(5);
    expect(await sceneRev(pool, stageId, 's1')).toBe(2);
    expect(await sceneRev(pool, stageId, 's2')).toBe(1);
  });

  it('deleteScene bumps the stage revision and removes the scene entry', async () => {
    const stageId = 'agent-delete-scene';
    await ownerStore.saveDocument(
      makeDoc(stageId, [
        { id: 's1', order: 1 },
        { id: 's2', order: 2 },
      ]),
    );
    await ownerStore.deleteScene(stageId, 's2');

    const manifest = (await readManifest(stageId))!;
    expect(manifest.rev).toBe(4);
    expect(manifest.scenes).toEqual([{ id: 's1', order: 1, rev: 1 }]);
    expect(await sceneRev(pool, stageId, 's1')).toBe(1);
  });

  it('reads rev 0 for rows the trigger never bumped (companion rows truncated)', async () => {
    const stageId = 'gap-stage';
    await ownerStore.saveDocument(makeDoc(stageId, [{ id: 's1', order: 1 }]));
    // Simulate rows written before the trigger existed: wipe the companion
    // tables while leaving the document rows behind.
    await pool.query('TRUNCATE document_scene_revision, document_stage_revision');

    expect(await readManifest(stageId)).toEqual({
      rev: 0,
      scenes: [{ id: 's1', order: 1, rev: 0 }],
    });
  });

  it('answers null for a missing or foreign stage', async () => {
    await ownerStore.saveDocument(makeDoc('owned-stage', [{ id: 's1', order: 1 }]));
    expect(await readManifest('absent-stage')).toBeNull();
    // A different owner cannot read this owner's manifest.
    const otherOwner = new PgDocumentStore(pool as Queryable, {
      withTransaction: transactionFor(pool),
    }).forOwner('owner-2');
    expect(await otherOwner.readFreshnessManifest('owned-stage')).toBeNull();
  });

  it('fault injection: without the triggers the revisions do not move (the signal is DB-borne)', async () => {
    // This is the suite's mutation guard: every other test in this file
    // asserts that writes DO move the revisions; this one proves that motion
    // comes from the triggers and nowhere else. With the triggers dropped, the
    // same write leaves the companion tables untouched — so a future change
    // that silently removes the trigger provisioning makes every other test
    // here fail, and this one still passes, pinning the mechanism in place.
    const stageId = 'fault-injection';
    await ownerStore.saveDocument(makeDoc(stageId, [{ id: 's1', order: 1 }]));
    expect(await sceneRev(pool, stageId, 's1')).toBe(1);

    await pool.query('DROP TRIGGER IF EXISTS openmaic_scene_revision_trigger ON document_scenes');
    await pool.query('DROP TRIGGER IF EXISTS openmaic_stage_revision_trigger ON document_stages');
    try {
      await pool.query(
        'UPDATE document_scenes SET scene_order = $3 WHERE stage_id = $1 AND id = $2',
        [stageId, 's1', 5],
      );
      expect(await sceneRev(pool, stageId, 's1')).toBe(1);
      expect(await stageRev(pool, stageId)).toBe(2);
    } finally {
      // Restore the triggers so the next test starts from the provisioned
      // schema; ensureDocumentSchema is idempotent.
      await ensureDocumentSchema(pool as Queryable);
    }
  });
});
