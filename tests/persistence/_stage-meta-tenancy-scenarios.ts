/**
 * Course tenancy lives in `stage_meta` alone: the scenarios, shared by the
 * PGlite suite and the PostgreSQL one so both engines run exactly the same
 * assertions.
 *
 * Each scenario is handed a pool whose database is empty, boots the server
 * persistence provider on it (the schema work and the ownership backfill),
 * and drives the owner-bound document store the routes use.
 */
import { DSL_VERSION } from '@openmaic/dsl';
import { expect, vi } from 'vitest';

import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';
import {
  createOwnerBoundDocumentStore,
  type TransactionSource,
} from '@/lib/persistence/owner-bound-document-store';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export interface ScenarioPool extends TransactionSource {
  query<TRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: TRow[] }>;
}

export const ALICE = 'user:alice';
export const BOB = 'user:bob';
const NOW = 1_800_000_000_000;

export function courseDocument(stageId: string, name = stageId) {
  return {
    stage: { id: stageId, name, createdAt: NOW, updatedAt: NOW },
    scenes: [
      {
        id: `${stageId}-scene`,
        stageId,
        type: 'slide' as const,
        title: 'Scene',
        order: 0,
        content: {
          type: 'slide' as const,
          canvas: {
            id: `${stageId}-canvas`,
            viewportSize: 1000,
            viewportRatio: 0.5625,
            elements: [],
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#000000'],
              fontColor: '#000000',
              fontName: 'Arial',
            },
          },
        },
      },
    ],
    outline: {
      outlines: [],
      requirement: name,
      generationComplete: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

/** An access refusal from the ownership gate, not a validation failure. */
const REFUSED = { name: 'StageAccessError' };

let boots = 0;

/** Boot a fresh provider on `pool`, as a new process would. */
export async function boot(pool: ScenarioPool, base = 'postgres://tenancy'): Promise<void> {
  boots += 1;
  await getServerPersistenceProvider(`${base}-${boots}`, () => pool as never);
}

export function storeFor(pool: ScenarioPool, ownerId: string) {
  return createOwnerBoundDocumentStore({
    pool,
    ownerId,
    validateScene: validateAppScene,
    validateStage: validateAppStage,
    createHooks: { name: 'none' },
  });
}

async function ids(promise: Promise<Array<{ id: string }>>): Promise<string[]> {
  return (await promise).map((summary) => summary.id).sort();
}

async function stageMetaRows(pool: ScenarioPool) {
  return (
    await pool.query<{ stage_id: string; owner_id: string; deleted: boolean }>(
      `SELECT stage_id, owner_id, deleted_at IS NOT NULL AS deleted
         FROM stage_meta ORDER BY stage_id`,
    )
  ).rows;
}

/** A fresh install: no ownership column, and every guarantee through `stage_meta`. */
export async function freshInstallScenario(pool: ScenarioPool): Promise<void> {
  await boot(pool);
  const column = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid = to_regclass('document_stages')
          AND attname = 'owner_id' AND NOT attisdropped
     ) AS present`,
  );
  expect(column.rows[0]?.present).toBe(false);

  const alice = storeFor(pool, ALICE);
  const bob = storeFor(pool, BOB);
  await alice.saveDocument(courseDocument('alice-1'));
  await alice.saveDocument(courseDocument('alice-2'));
  await bob.saveDocument(courseDocument('bob-1'));

  // Listing: each owner exactly their own.
  expect(await ids(alice.listDocuments())).toEqual(['alice-1', 'alice-2']);
  expect(await ids(bob.listDocuments())).toEqual(['bob-1']);

  // Reads remain capability-by-id.
  await expect(alice.loadDocument('bob-1')).resolves.toMatchObject({ stage: { id: 'bob-1' } });
  await expect(alice.getScene('bob-1', 'bob-1-scene')).resolves.toMatchObject({
    id: 'bob-1-scene',
  });

  // Writes to another owner's course are refused on every path, and change nothing.
  const before = JSON.stringify(await bob.loadDocument('bob-1'));
  await expect(alice.saveDocument(courseDocument('bob-1', 'Taken'))).rejects.toMatchObject(REFUSED);
  await expect(
    alice.putStage('bob-1', { id: 'bob-1', name: 'Taken', createdAt: NOW, updatedAt: NOW }),
  ).rejects.toMatchObject(REFUSED);
  await expect(
    alice.putScene('bob-1', { ...courseDocument('bob-1').scenes[0]!, title: 'Taken' }),
  ).rejects.toMatchObject(REFUSED);
  await expect(alice.deleteScene('bob-1', 'bob-1-scene')).rejects.toMatchObject(REFUSED);
  await expect(alice.deleteDocument('bob-1')).rejects.toMatchObject(REFUSED);
  expect(JSON.stringify(await bob.loadDocument('bob-1'))).toBe(before);
  expect(await ids(bob.listDocuments())).toEqual(['bob-1']);

  // The owner edits its own course.
  await alice.putStage('alice-1', {
    id: 'alice-1',
    name: 'Renamed',
    createdAt: NOW,
    updatedAt: NOW + 1,
  });
  await expect(alice.loadDocument('alice-1')).resolves.toMatchObject({
    stage: { name: 'Renamed' },
  });

  // Folders keep working for owned courses, and never reach another owner's.
  const { folder } = await alice.createFolder('shared-id', 'Alice folder');
  await bob.createFolder('shared-id', 'Bob folder');
  await expect(alice.setStageFolder('alice-1', folder.id)).resolves.toBe(true);
  await expect(bob.setStageFolder('bob-1', 'shared-id')).resolves.toBe(true);
  // Filing another owner's course into a folder of the same id writes nothing.
  await expect(alice.setStageFolder('bob-1', 'shared-id')).resolves.toBe(false);
  await expect(alice.setStageFolder('bob-1', null)).resolves.toBe(true);
  expect(await ids(alice.listDocuments('shared-id'))).toEqual(['alice-1']);
  expect(await ids(bob.listDocuments('shared-id'))).toEqual(['bob-1']);
  await expect(alice.deleteFolder('shared-id', 'remove')).resolves.toEqual({
    removedStageIds: ['alice-1'],
  });
  expect(await ids(bob.listDocuments('shared-id'))).toEqual(['bob-1']);

  // Deleting is a tombstone in stage_meta: gone from the listing, rows kept.
  await alice.deleteDocument('alice-2');
  expect(await ids(alice.listDocuments())).toEqual(['alice-1']);
  await expect(alice.loadDocument('alice-2')).resolves.toBeNull();
  await expect(alice.saveDocument(courseDocument('alice-2'))).rejects.toMatchObject(REFUSED);

  // Ownership is recorded once, in stage_meta.
  expect(await stageMetaRows(pool)).toEqual([
    { stage_id: 'alice-1', owner_id: ALICE, deleted: false },
    { stage_id: 'alice-2', owner_id: ALICE, deleted: true },
    { stage_id: 'bob-1', owner_id: BOB, deleted: false },
  ]);
}

/**
 * The document tables as the previous release provisioned them: ownership on
 * the document row (with its indexes), and a `stage_meta` that some courses
 * predate.
 */
async function provisionPreviousRelease(pool: ScenarioPool): Promise<void> {
  const statements = [
    `CREATE TABLE document_folders (
       owner_id TEXT NOT NULL,
       id TEXT NOT NULL,
       name TEXT NOT NULL,
       normalized_name TEXT NOT NULL,
       created_at DOUBLE PRECISION NOT NULL,
       updated_at DOUBLE PRECISION NOT NULL,
       folder_order DOUBLE PRECISION NOT NULL DEFAULT 0,
       PRIMARY KEY (owner_id, id),
       UNIQUE (owner_id, normalized_name)
     )`,
    `CREATE TABLE document_stages (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       description TEXT,
       interactive_mode BOOLEAN,
       task_engine_mode BOOLEAN,
       created_at DOUBLE PRECISION NOT NULL,
       updated_at DOUBLE PRECISION NOT NULL,
       owner_id TEXT,
       folder_id TEXT,
       data JSONB NOT NULL
     )`,
    `CREATE INDEX document_stages_owner_idx
       ON document_stages (owner_id, id) WHERE owner_id IS NOT NULL`,
    `CREATE INDEX document_stages_owner_folder_idx
       ON document_stages (owner_id, folder_id, id)
       WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL`,
    `CREATE TABLE document_scenes (
       stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
       id TEXT NOT NULL,
       scene_order DOUBLE PRECISION NOT NULL,
       data JSONB NOT NULL,
       PRIMARY KEY (stage_id, id)
     )`,
    `CREATE TABLE stage_meta (
       stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
       owner_id TEXT NOT NULL,
       is_public BOOLEAN NOT NULL DEFAULT false,
       deleted_at TIMESTAMPTZ
     )`,
  ];
  for (const statement of statements) await pool.query(statement);
}

async function insertLegacyCourse(
  pool: ScenarioPool,
  stageId: string,
  ownerId: string | null,
  folderId: string | null = null,
): Promise<void> {
  const doc = courseDocument(stageId);
  await pool.query(
    `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, folder_id, data)
     VALUES ($1, $2, $3, $3, $4, $5, $6::jsonb)`,
    [
      stageId,
      stageId,
      NOW,
      ownerId,
      folderId,
      JSON.stringify({ ...doc.stage, dslVersion: DSL_VERSION }),
    ],
  );
  await pool.query(
    `INSERT INTO document_scenes (stage_id, id, scene_order, data) VALUES ($1, $2, 0, $3::jsonb)`,
    [stageId, doc.scenes[0]!.id, JSON.stringify(doc.scenes[0])],
  );
}

/**
 * An upgrade from the previous release: courses whose owner is recorded only
 * on the document row are adopted into `stage_meta` at boot, nothing is lost
 * or misattributed, and a second boot changes nothing.
 */
export async function upgradeScenario(pool: ScenarioPool): Promise<void> {
  await provisionPreviousRelease(pool);
  // Alice: one course already in stage_meta, one known only by the column,
  // filed in her folder. Bob: one by the column only, one tombstoned.
  await insertLegacyCourse(pool, 'alice-meta', ALICE);
  await pool.query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ('alice-meta', $1)`, [
    ALICE,
  ]);
  await pool.query(
    `INSERT INTO document_folders (owner_id, id, name, normalized_name, created_at, updated_at)
     VALUES ($1, 'alice-folder', 'Series', 'series', 1, 1)`,
    [ALICE],
  );
  await insertLegacyCourse(pool, 'alice-column', ALICE, 'alice-folder');
  await insertLegacyCourse(pool, 'bob-column', BOB);
  await insertLegacyCourse(pool, 'bob-tombstoned', BOB);
  await pool.query(
    `INSERT INTO stage_meta (stage_id, owner_id, deleted_at)
     VALUES ('bob-tombstoned', $1, now())`,
    [BOB],
  );
  // The two records disagree: stage_meta already decided every access check,
  // so it stays authoritative and the column is only counted.
  await insertLegacyCourse(pool, 'disputed', ALICE);
  await pool.query(`INSERT INTO stage_meta (stage_id, owner_id) VALUES ('disputed', $1)`, [BOB]);
  // Nobody's: never reachable before, not adopted now.
  await insertLegacyCourse(pool, 'unowned', null);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await boot(pool);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/adopted 2 owned course\(s\)/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[stage-meta\] 1 course\(s\)/));
    const expectedMeta = [
      { stage_id: 'alice-column', owner_id: ALICE, deleted: false },
      { stage_id: 'alice-meta', owner_id: ALICE, deleted: false },
      { stage_id: 'bob-column', owner_id: BOB, deleted: false },
      { stage_id: 'bob-tombstoned', owner_id: BOB, deleted: true },
      { stage_id: 'disputed', owner_id: BOB, deleted: false },
    ];
    expect(await stageMetaRows(pool)).toEqual(expectedMeta);

    const alice = storeFor(pool, ALICE);
    const bob = storeFor(pool, BOB);
    expect(await ids(alice.listDocuments())).toEqual(['alice-column', 'alice-meta']);
    expect(await ids(bob.listDocuments())).toEqual(['bob-column', 'disputed']);
    // No course row was lost.
    const stages = await pool.query<{ id: string }>('SELECT id FROM document_stages ORDER BY id');
    expect(stages.rows.map((row) => row.id)).toEqual([
      'alice-column',
      'alice-meta',
      'bob-column',
      'bob-tombstoned',
      'disputed',
      'unowned',
    ]);
    // Folder membership written by the previous release still lists.
    expect(await ids(alice.listDocuments('alice-folder'))).toEqual(['alice-column']);
    // Adopted courses are writable by their owner and by nobody else.
    await alice.putStage('alice-column', {
      id: 'alice-column',
      name: 'Edited',
      createdAt: NOW,
      updatedAt: NOW + 1,
    });
    await expect(bob.saveDocument(courseDocument('alice-column'))).rejects.toMatchObject(REFUSED);
    await expect(alice.saveDocument(courseDocument('disputed'))).rejects.toMatchObject(REFUSED);
    await expect(alice.saveDocument(courseDocument('unowned'))).rejects.toMatchObject(REFUSED);

    // A course created after the upgrade leaves the retired column empty.
    await alice.saveDocument(courseDocument('alice-new'));
    const written = await pool.query<{ owner_id: string | null }>(
      `SELECT owner_id FROM document_stages WHERE id = 'alice-new'`,
    );
    expect(written.rows).toEqual([{ owner_id: null }]);
    expect(await ids(alice.listDocuments())).toEqual(['alice-column', 'alice-meta', 'alice-new']);

    // A second boot adopts nothing and changes nothing.
    warn.mockClear();
    await boot(pool);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/adopted/));
    expect(await stageMetaRows(pool)).toEqual([
      ...expectedMeta.slice(0, 2),
      { stage_id: 'alice-new', owner_id: ALICE, deleted: false },
      ...expectedMeta.slice(2),
    ]);
  } finally {
    warn.mockRestore();
  }
}
