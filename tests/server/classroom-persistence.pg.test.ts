/**
 * The create-only course write behind the legacy classroom import
 * (`saveCompletedClassroom`) and every other `createDocument` caller, on
 * PostgreSQL: an id any course holds is never replaced, and a create that
 * throws inside its transaction leaves nothing behind.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import { createOwnerBoundDocumentStore } from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { saveCompletedClassroom } from '@/lib/server/classroom-persistence';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_classroom_persistence_test';
const OWNER = 'user:teacher';
const OTHER = 'user:visitor';

describe.skipIf(!contractUrl)('create-only course writes on PostgreSQL', () => {
  let admin: Pool;
  let pool: Pool;
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    ASSET_S3_BUCKET: process.env.ASSET_S3_BUCKET,
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=classroom-persistence`;
    process.env.DATABASE_URL = databaseUrl;
    process.env.ASSET_S3_BUCKET = '';
    await getServerPersistenceProvider(databaseUrl, () => pool);
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

  function store(ownerId: string) {
    return createOwnerBoundDocumentStore({
      pool,
      ownerId,
      validateScene: validateAppScene,
      validateStage: validateAppStage,
    });
  }

  function shell(id: string, name: string) {
    return { stage: { id, name, createdAt: 1, updatedAt: 1 }, scenes: [], outlines: [] };
  }

  it("never replaces a course that holds the id, the owner's own or another's", async () => {
    await store(OWNER).saveDocument({ stage: shell('stage-own', 'Mine').stage, scenes: [] });
    await store(OTHER).saveDocument({ stage: shell('stage-theirs', 'Theirs').stage, scenes: [] });

    for (const id of ['stage-own', 'stage-theirs']) {
      await expect(saveCompletedClassroom(OWNER, shell(id, 'Generated'))).rejects.toMatchObject({
        code: 'STAGE_ID_TAKEN',
      });
    }
    expect((await store(OWNER).loadDocument('stage-own'))?.stage.name).toBe('Mine');
    expect((await store(OTHER).loadDocument('stage-theirs'))?.stage.name).toBe('Theirs');
  });

  it('refuses a deleted id and a document row without ownership', async () => {
    const owned = store(OWNER);
    await owned.saveDocument({ stage: shell('stage-deleted', 'Gone').stage, scenes: [] });
    await owned.deleteDocument('stage-deleted');
    await pool.query(
      `INSERT INTO document_stages (id, name, data, created_at, updated_at)
       VALUES ('stage-orphan', 'Orphan', '{}'::jsonb, 1, 1)`,
    );

    for (const id of ['stage-deleted', 'stage-orphan']) {
      await expect(owned.createDocument(shell(id, 'New'))).rejects.toMatchObject({
        code: 'STAGE_ID_TAKEN',
      });
    }
    const meta = await pool.query('SELECT 1 FROM stage_meta WHERE stage_id = $1', ['stage-orphan']);
    expect(meta.rows).toEqual([]);
  });

  it("mirrors a saved outline's generation-complete flag onto the ownership row", async () => {
    const generationComplete = async (stageId: string) =>
      (
        await pool.query('SELECT generation_complete FROM stage_meta WHERE stage_id = $1', [
          stageId,
        ])
      ).rows[0]?.generation_complete;
    const outline = (complete: boolean) => ({
      outlines: [],
      generationComplete: complete,
      createdAt: 1,
      updatedAt: 1,
    });
    const owned = store(OWNER);

    // A whole-document save (what the browser importer sends) of a finished course.
    const finished = shell('stage-imported-complete', 'Imported').stage;
    await owned.saveDocument({ stage: finished, scenes: [], outline: outline(true) });
    expect(await generationComplete('stage-imported-complete')).toBe(true);

    // An outline that is not complete leaves the flag unset; a later save that
    // completes it sets it.
    const unfinished = shell('stage-imported-pending', 'Pending').stage;
    await owned.saveDocument({ stage: unfinished, scenes: [], outline: outline(false) });
    expect(await generationComplete('stage-imported-pending')).toBe(false);
    await owned.saveDocument({ stage: unfinished, scenes: [], outline: outline(true) });
    expect(await generationComplete('stage-imported-pending')).toBe(true);

    // The server-side classroom import gets the same through `createDocument`.
    await saveCompletedClassroom(OWNER, shell('stage-server-import', 'Server import'));
    expect(await generationComplete('stage-server-import')).toBe(true);
  });

  it('rolls back the course, its ownership and the extra rows when inTransaction throws', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS extra_rows (stage_id TEXT)');
    await expect(
      store(OWNER).createDocument(shell('stage-rolled-back', 'Rolled back'), {
        inTransaction: async (tx) => {
          await tx.query("INSERT INTO extra_rows (stage_id) VALUES ('stage-rolled-back')");
          throw new Error('ledger write failed');
        },
      }),
    ).rejects.toThrow('ledger write failed');

    for (const sql of [
      "SELECT 1 FROM document_stages WHERE id = 'stage-rolled-back'",
      "SELECT 1 FROM stage_meta WHERE stage_id = 'stage-rolled-back'",
      "SELECT 1 FROM extra_rows WHERE stage_id = 'stage-rolled-back'",
    ]) {
      expect((await pool.query(sql)).rows).toEqual([]);
    }
  });
});
