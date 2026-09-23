import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { DSL_VERSION } from '@openmaic/dsl';
import {
  PgDocumentStore,
  ensureDocumentSchema,
  type PgDocumentStoreOptions,
  type QueryResult,
  type Queryable,
} from '../src/document/pg.js';
import {
  DocumentFolderLimitError,
  DocumentNotFoundError,
  DocumentVersionError,
  type DocumentStore,
} from '../src/document/types.js';
import { makeDocument, runDocumentStoreContract, slideScene } from './document-contract.js';

function transactionOptions(db: PGlite): PgDocumentStoreOptions {
  return {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  };
}

/**
 * A host's ownership relation, as a host that keeps ownership beside the
 * document tables provisions it: one row per owned document, cascading with
 * it, with a tombstone column.
 */
async function provisionOwnershipRelation(db: PGlite): Promise<void> {
  await db.query(`CREATE TABLE document_owners (
    stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    retired_at TIMESTAMPTZ
  )`);
}

const OWNERSHIP = {
  table: 'document_owners',
  tombstoneColumn: 'retired_at',
} as const;

/** The same relation, with the store claiming the rows of what it creates. */
const CLAIMING_OWNERSHIP = { ...OWNERSHIP, claimOnCreate: true } as const;

async function restamp(db: PGlite, stageId: string, version: string | undefined): Promise<void> {
  const result = await db.query<{ data: unknown }>(
    'SELECT data FROM document_stages WHERE id = $1',
    [stageId],
  );
  const data = result.rows[0]!.data as Record<string, unknown>;
  if (version === undefined) delete data.dslVersion;
  else data.dslVersion = version;
  await db.query('UPDATE document_stages SET data = $2::jsonb WHERE id = $1', [
    stageId,
    JSON.stringify(data),
  ]);
}

describe('PgDocumentStore with PGlite', () => {
  let db: PGlite;
  let store: DocumentStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    store = new PgDocumentStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  runDocumentStoreContract('Postgres (PGlite)', () => ({
    store,
    seedStoredVersion: (stageId, version) => restamp(db, stageId, version),
  }));
});

describe('owner-scoped PgDocumentStore contract', () => {
  let db: PGlite;
  let store: DocumentStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await provisionOwnershipRelation(db);
    store = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: CLAIMING_OWNERSHIP,
    }).forOwner('anon:contract-owner');
  });

  afterEach(async () => {
    await db.close();
  });

  runDocumentStoreContract('Postgres owner scope (PGlite)', () => ({
    store,
    seedStoredVersion: (stageId, version) => restamp(db, stageId, version),
  }));
});

describe('owner-scoped document folders', () => {
  let db: PGlite;
  let alice: PgDocumentStore;
  let bob: PgDocumentStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    await provisionOwnershipRelation(db);
    const root = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: CLAIMING_OWNERSHIP,
    });
    alice = root.forOwner('anon:alice');
    bob = root.forOwner('anon:bob');
  });

  afterEach(async () => {
    await db.close();
  });

  test('represents empty folders and reuses names case-insensitively', async () => {
    const created = await alice.createFolder('folder-a', 'Series');
    const reused = await alice.createFolder('folder-other', 'series');

    expect(created).toMatchObject({ reused: false, folder: { id: 'folder-a', name: 'Series' } });
    expect(reused).toMatchObject({ reused: true, folder: { id: 'folder-a', name: 'Series' } });
    await expect(alice.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: 'folder-a', name: 'Series' }),
    ]);
    await expect(alice.listDocuments('folder-a')).resolves.toEqual([]);
  });

  test('moves idempotently and lists membership without changing the document body', async () => {
    await alice.createFolder('folder-a', 'Series');
    await alice.saveDocument(makeDocument('alice-stage'));
    const before = await alice.loadDocument('alice-stage');

    await expect(alice.moveDocumentToFolder('alice-stage', 'folder-a')).resolves.toBe(true);
    await expect(alice.moveDocumentToFolder('alice-stage', 'folder-a')).resolves.toBe(true);
    await expect(alice.listDocuments('folder-a')).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage', folderId: 'folder-a' }),
    ]);
    expect(await alice.loadDocument('alice-stage')).toEqual(before);
  });

  test('isolates folders and membership in both owner directions', async () => {
    await alice.createFolder('same-id', 'Alice folder');
    await bob.createFolder('same-id', 'Bob folder');
    await alice.saveDocument(makeDocument('alice-stage'));
    await bob.saveDocument(makeDocument('bob-stage'));

    await expect(alice.listFolders()).resolves.toEqual([
      expect.objectContaining({ name: 'Alice folder' }),
    ]);
    await expect(bob.listFolders()).resolves.toEqual([
      expect.objectContaining({ name: 'Bob folder' }),
    ]);
    await expect(alice.moveDocumentToFolder('bob-stage', 'same-id')).resolves.toBe(false);
    await expect(bob.moveDocumentToFolder('alice-stage', 'same-id')).resolves.toBe(false);
    await expect(alice.moveDocumentToFolder('alice-stage', 'missing-folder')).resolves.toBe(false);
  });

  test('enforces the owner folder count limit', async () => {
    await alice.createFolder('folder-a', 'One', 1);
    await expect(alice.createFolder('folder-b', 'Two', 1)).rejects.toBeInstanceOf(
      DocumentFolderLimitError,
    );
  });

  test('assigns ascending orders on create and lists by order', async () => {
    const first = await alice.createFolder('folder-a', 'First');
    const second = await alice.createFolder('folder-b', 'Second');
    await bob.createFolder('folder-x', 'Bob first');

    expect(first.folder.order).toBe(0);
    expect(second.folder.order).toBe(1);
    // Each owner's orders are independent.
    await expect(bob.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: 'folder-x', order: 0 }),
    ]);
    const listed = await alice.listFolders();
    expect(listed.map((folder) => folder.order)).toEqual([0, 1]);
    expect(listed.map((folder) => folder.name)).toEqual(['First', 'Second']);
  });

  test('renames an owned folder and returns null for a missing one', async () => {
    await alice.createFolder('folder-a', 'Series');

    const renamed = await alice.renameFolder('folder-a', 'Semester');
    expect(renamed).toMatchObject({ id: 'folder-a', name: 'Semester' });
    await expect(alice.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: 'folder-a', name: 'Semester' }),
    ]);
    await expect(alice.renameFolder('missing', 'X')).resolves.toBeNull();
  });

  test('rename to a case-insensitive duplicate name violates the unique constraint', async () => {
    await alice.createFolder('folder-a', 'Series');
    await alice.createFolder('folder-b', 'Semester');

    await expect(alice.renameFolder('folder-b', 'SERIES')).rejects.toMatchObject({ code: '23505' });
    // The original name is untouched after the refused rename.
    await expect(alice.listFolders()).resolves.toEqual([
      expect.objectContaining({ id: 'folder-a', name: 'Series' }),
      expect.objectContaining({ id: 'folder-b', name: 'Semester' }),
    ]);
  });

  test("deleteFolder 'ungroup' drops the folder and keeps its documents unfiled", async () => {
    await alice.createFolder('folder-a', 'Series');
    await alice.saveDocument(makeDocument('alice-stage'));
    await alice.moveDocumentToFolder('alice-stage', 'folder-a');

    await expect(alice.deleteFolder('folder-a', 'ungroup')).resolves.toEqual({
      removedStageIds: [],
    });
    await expect(alice.listFolders()).resolves.toEqual([]);
    await expect(alice.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage' }),
    ]);
    await expect(alice.listDocuments('folder-a')).resolves.toEqual([]);
    await expect(alice.deleteFolder('folder-a', 'ungroup')).resolves.toBeNull();
  });

  test("deleteFolder 'remove' returns the captured member ids for the caller's cascade", async () => {
    await alice.createFolder('folder-a', 'Series');
    await alice.saveDocument(makeDocument('alice-stage-1'));
    await alice.saveDocument(makeDocument('alice-stage-2'));
    await alice.moveDocumentToFolder('alice-stage-1', 'folder-a');
    await alice.moveDocumentToFolder('alice-stage-2', 'folder-a');

    await expect(alice.deleteFolder('folder-a', 'remove')).resolves.toEqual({
      removedStageIds: ['alice-stage-1', 'alice-stage-2'],
    });
    await expect(alice.listFolders()).resolves.toEqual([]);
    // The documents themselves survive; only their folder pointers are cleared.
    await expect(alice.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage-1' }),
      expect.objectContaining({ id: 'alice-stage-2' }),
    ]);
    await expect(alice.deleteFolder('folder-a', 'remove')).resolves.toBeNull();
  });

  test('setStageFolder files, un-files idempotently, and refuses foreign folders', async () => {
    await alice.createFolder('folder-a', 'Series');
    await bob.createFolder('folder-a', 'Bob series');
    await alice.saveDocument(makeDocument('alice-stage'));

    await expect(alice.setStageFolder('alice-stage', 'folder-a')).resolves.toBe(true);
    await expect(alice.setStageFolder('alice-stage', 'folder-a')).resolves.toBe(true);
    await expect(alice.listDocuments('folder-a')).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage', folderId: 'folder-a' }),
    ]);
    // Un-filing is idempotent and never refuses, even for an absent stage.
    await expect(alice.setStageFolder('alice-stage', null)).resolves.toBe(true);
    await expect(alice.setStageFolder('alice-stage', null)).resolves.toBe(true);
    await expect(alice.listDocuments('folder-a')).resolves.toEqual([]);
    // A folder that exists but belongs to somebody else refuses the write.
    await expect(alice.setStageFolder('alice-stage', 'folder-a')).resolves.toBe(true);
    await expect(bob.setStageFolder('alice-stage', 'folder-a')).resolves.toBe(false);
  });

  test('folder membership is scoped by document ownership when two owners share a folder id', async () => {
    // Folder ids are unique per owner only, and the document row no longer
    // says whose it is: membership has to go through the ownership relation.
    await alice.createFolder('same-id', 'Alice folder');
    await bob.createFolder('same-id', 'Bob folder');
    await alice.saveDocument(makeDocument('alice-stage'));
    await bob.saveDocument(makeDocument('bob-stage'));
    await expect(alice.setStageFolder('alice-stage', 'same-id')).resolves.toBe(true);
    await expect(bob.setStageFolder('bob-stage', 'same-id')).resolves.toBe(true);

    await expect(alice.listDocuments('same-id')).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage', folderId: 'same-id' }),
    ]);
    // Un-filing another owner's course is a no-op, not a write.
    await alice.setStageFolder('bob-stage', null);
    await expect(bob.listDocuments('same-id')).resolves.toEqual([
      expect.objectContaining({ id: 'bob-stage' }),
    ]);
    // Removing Alice's folder hands back Alice's course only, and leaves Bob's
    // course filed in Bob's folder of the same id.
    await expect(alice.deleteFolder('same-id', 'remove')).resolves.toEqual({
      removedStageIds: ['alice-stage'],
    });
    await expect(bob.listDocuments('same-id')).resolves.toEqual([
      expect.objectContaining({ id: 'bob-stage', folderId: 'same-id' }),
    ]);
  });
});

describe('PgDocumentStore Postgres behavior', () => {
  let db: PGlite;
  let store: PgDocumentStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureDocumentSchema(db);
    store = new PgDocumentStore(db, transactionOptions(db));
  });

  afterEach(async () => {
    await db.close();
  });

  test('ensureDocumentSchema is idempotent and provisions the normalized tables', async () => {
    await expect(ensureDocumentSchema(db)).resolves.toBeUndefined();
    await expect(ensureDocumentSchema(db)).resolves.toBeUndefined();

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'document_folders', 'document_stages', 'document_scenes', 'document_outlines'
          )
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'document_folders',
      'document_outlines',
      'document_scenes',
      'document_stages',
    ]);
  });

  test('a fresh install has no ownership column on document_stages', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name = 'document_stages'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'name',
      'description',
      'interactive_mode',
      'task_engine_mode',
      'created_at',
      'updated_at',
      'folder_id',
      'data',
    ]);
  });

  test('ensureDocumentSchema keeps a legacy owner column, relaxes it, and drops its indexes', async () => {
    const legacy = new PGlite();
    await legacy.waitReady;
    try {
      // The pre-change shape, hardened the way a host might have: NOT NULL
      // and a default would fail or mislabel every write that no longer
      // names the column.
      await legacy.query(`CREATE TABLE document_stages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        interactive_mode BOOLEAN,
        task_engine_mode BOOLEAN,
        created_at DOUBLE PRECISION NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL,
        owner_id TEXT NOT NULL DEFAULT 'nobody',
        folder_id TEXT,
        data JSONB NOT NULL
      )`);
      await legacy.query(
        `CREATE INDEX document_stages_owner_idx ON document_stages (owner_id, id)
          WHERE owner_id IS NOT NULL`,
      );
      await legacy.query(
        `INSERT INTO document_stages (id, name, created_at, updated_at, owner_id, data)
         VALUES ('old-stage', 'Old', 1, 1, 'anon:alice', '{}'::jsonb)`,
      );
      await ensureDocumentSchema(legacy);
      await ensureDocumentSchema(legacy);

      const columns = await legacy.query<{
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'document_stages' AND column_name = 'owner_id'`,
      );
      expect(columns.rows).toEqual([
        { column_name: 'owner_id', is_nullable: 'YES', column_default: null },
      ]);
      const indexes = await legacy.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'document_stages' ORDER BY indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'document_stages_folder_idx',
        'document_stages_pkey',
      ]);
      // The recorded owner is kept for the host's backfill and a rollback.
      const kept = await legacy.query<{ owner_id: string }>(
        `SELECT owner_id FROM document_stages WHERE id = 'old-stage'`,
      );
      expect(kept.rows).toEqual([{ owner_id: 'anon:alice' }]);

      // A new document is written without the column and leaves it NULL.
      const legacyStore = new PgDocumentStore(legacy, transactionOptions(legacy));
      await legacyStore.saveDocument(makeDocument('new-stage'));
      const written = await legacy.query<{ owner_id: string | null }>(
        `SELECT owner_id FROM document_stages WHERE id = 'new-stage'`,
      );
      expect(written.rows).toEqual([{ owner_id: null }]);
    } finally {
      await legacy.close();
    }
  });

  test('works against a host table with no ownership column and no folder column', async () => {
    const host = new PGlite();
    await host.waitReady;
    try {
      // A host provisioning its own tables with only the columns the store
      // needs, and its own ownership relation.
      await host.query(`CREATE TABLE document_stages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        interactive_mode BOOLEAN,
        task_engine_mode BOOLEAN,
        created_at DOUBLE PRECISION NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL,
        data JSONB NOT NULL
      )`);
      await host.query(`CREATE TABLE document_scenes (
        stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        scene_order DOUBLE PRECISION NOT NULL,
        data JSONB NOT NULL,
        PRIMARY KEY (stage_id, id)
      )`);
      await host.query(`CREATE TABLE document_outlines (
        stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
        data JSONB NOT NULL
      )`);
      await host.query(`CREATE TABLE host_course_owners (
        course_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
        account TEXT NOT NULL
      )`);
      const root = new PgDocumentStore(host, {
        ...transactionOptions(host),
        folders: false,
        documentOwnership: {
          table: 'host_course_owners',
          stageIdColumn: 'course_id',
          ownerIdColumn: 'account',
          claimOnCreate: true,
        },
      });
      const alice = root.forOwner('alice');
      const bob = root.forOwner('bob');

      await alice.saveDocument(makeDocument('alice-stage'));
      await bob.saveDocument(makeDocument('bob-stage'));
      await alice.putScene('alice-stage', slideScene('alice-stage', 'scene-c', 5));
      await expect(alice.listDocuments()).resolves.toEqual([
        expect.objectContaining({ id: 'alice-stage', sceneCount: 3 }),
      ]);
      expect((await alice.listDocuments())[0]).not.toHaveProperty('folderId');
      await expect(bob.saveDocument(makeDocument('alice-stage'))).rejects.toBeInstanceOf(
        DocumentNotFoundError,
      );
      await expect(alice.loadDocument('bob-stage')).resolves.toMatchObject({
        stage: { id: 'bob-stage' },
      });
      await expect(alice.listFolders()).rejects.toThrow(/folders: false/);
      await expect(alice.listDocuments('any')).rejects.toThrow(/folders: false/);
      await alice.deleteDocument('alice-stage');
      await expect(root.listDocuments()).resolves.toEqual([
        expect.objectContaining({ id: 'bob-stage' }),
      ]);
    } finally {
      await host.close();
    }
  });

  test('owner scopes filter lists and writes through the ownership relation', async () => {
    await provisionOwnershipRelation(db);
    const root = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: CLAIMING_OWNERSHIP,
    });
    const alice = root.forOwner('anon:alice');
    const bob = root.forOwner('anon:bob');
    await alice.saveDocument(makeDocument('alice-stage'));
    await bob.saveDocument(makeDocument('bob-stage'));

    // Reads remain capability-by-id.
    await expect(alice.loadDocument('bob-stage')).resolves.toMatchObject({
      stage: { id: 'bob-stage' },
    });
    await expect(bob.getScene('alice-stage', 'scene-a')).resolves.toMatchObject({
      stageId: 'alice-stage',
    });
    await expect(alice.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage' }),
    ]);
    await expect(bob.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'bob-stage' }),
    ]);
    await expect(bob.readFreshnessManifest('alice-stage')).resolves.toBeNull();
    await expect(alice.readFreshnessManifest('alice-stage')).resolves.not.toBeNull();

    // Every write path refuses the other owner's document.
    await expect(bob.saveDocument(makeDocument('alice-stage'))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    await expect(
      bob.putStage('alice-stage', { id: 'alice-stage', name: 'Taken', createdAt: 1, updatedAt: 2 }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(
      bob.putScene('alice-stage', slideScene('alice-stage', 'scene-x', 9)),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    await bob.deleteScene('alice-stage', 'scene-a');
    await bob.deleteDocument('alice-stage');
    await expect(alice.loadDocument('alice-stage')).resolves.toMatchObject({
      stage: { id: 'alice-stage', name: 'Intro Course' },
      scenes: [expect.objectContaining({ id: 'scene-a' }), expect.anything()],
    });

    // The document row carries no owner; the relation holds exactly one.
    const owners = await db.query<{ stage_id: string; owner_id: string }>(
      'SELECT stage_id, owner_id FROM document_owners ORDER BY stage_id',
    );
    expect(owners.rows).toEqual([
      { stage_id: 'alice-stage', owner_id: 'anon:alice' },
      { stage_id: 'bob-stage', owner_id: 'anon:bob' },
    ]);

    // A retired document leaves the listing; the tombstone is the host's.
    await db.query(`UPDATE document_owners SET retired_at = now() WHERE stage_id = 'alice-stage'`);
    await expect(alice.listDocuments()).resolves.toEqual([]);
  });

  test('without claimOnCreate the host claims ownership, and a document nobody holds is not writable', async () => {
    await provisionOwnershipRelation(db);
    const alice = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: OWNERSHIP,
    }).forOwner('anon:alice');

    // A new document is written, but it is nobody's until the host claims it.
    await alice.saveDocument(makeDocument('alice-stage'));
    await expect(alice.listDocuments()).resolves.toEqual([]);
    const owners = await db.query('SELECT stage_id FROM document_owners');
    expect(owners.rows).toEqual([]);

    // Now it exists and nobody holds it: no owner-bound store may write it.
    await expect(alice.saveDocument(makeDocument('alice-stage'))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );

    await db.query(
      `INSERT INTO document_owners (stage_id, owner_id) VALUES ('alice-stage', 'anon:alice')`,
    );
    await expect(alice.saveDocument(makeDocument('alice-stage'))).resolves.toBeUndefined();
    await expect(alice.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage' }),
    ]);
  });

  test('an owner-bound store must say where ownership lives', () => {
    expect(() => store.forOwner('anon:alice')).toThrow(/requires documentOwnership/);
    expect(
      () => new PgDocumentStore(db, { ...transactionOptions(db), ownerId: 'anon:alice' }),
    ).toThrow(/requires documentOwnership/);
    for (const table of ['stage meta', 'Stage_Meta', 'a.b.c', 'x;drop table y', '']) {
      expect(
        () =>
          new PgDocumentStore(db, {
            ...transactionOptions(db),
            documentOwnership: { table },
          }),
      ).toThrow(/plain lower-case PostgreSQL identifier/);
    }
    expect(
      () =>
        new PgDocumentStore(db, {
          ...transactionOptions(db),
          documentOwnership: { table: 'public.owners', ownerIdColumn: 'owner-id' },
        }),
    ).toThrow(/ownerIdColumn/);
  });

  test('an owner-bound store without a relation needs the cross-owner acknowledgement', () => {
    // A folders-only bind must not silently unscope documents.
    const unscoped = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: false,
    });
    expect(() => unscoped.forOwner('anon:alice')).toThrow(/allowCrossOwnerDocumentAccess/);
    expect(
      () =>
        new PgDocumentStore(db, {
          ...transactionOptions(db),
          ownerId: 'anon:alice',
          documentOwnership: false,
          allowCrossOwnerDocumentAccess: false,
        }),
    ).toThrow(/allowCrossOwnerDocumentAccess/);
  });

  test('a leftover ownership row keeps its id reserved; a cascading relation frees it', async () => {
    await provisionOwnershipRelation(db);
    const root = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: CLAIMING_OWNERSHIP,
    });
    const alice = root.forOwner('anon:alice');
    const bob = root.forOwner('anon:bob');

    // With the foreign key cascading, deleting the document frees the id.
    await alice.saveDocument(makeDocument('cascading'));
    await alice.deleteDocument('cascading');
    await expect(bob.saveDocument(makeDocument('cascading'))).resolves.toBeUndefined();

    // An ownership row with no document row (a relation that does not cascade,
    // or a document deleted out of band) reserves the id for its owner.
    await db.query('ALTER TABLE document_owners DROP CONSTRAINT document_owners_stage_id_fkey');
    await alice.saveDocument(makeDocument('reserved'));
    await db.query(`DELETE FROM document_stages WHERE id = 'reserved'`);
    await expect(bob.saveDocument(makeDocument('reserved'))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    await expect(alice.saveDocument(makeDocument('reserved'))).resolves.toBeUndefined();
  });

  test('an unbound store, and a store bound without a relation, are tenant-agnostic', async () => {
    await store.saveDocument(makeDocument('first-stage'));
    const agnostic = new PgDocumentStore(db, {
      ...transactionOptions(db),
      documentOwnership: false,
      allowCrossOwnerDocumentAccess: true,
    }).forOwner('anon:agent');
    await agnostic.saveDocument(makeDocument('agent-stage'));
    await agnostic.saveDocument(makeDocument('first-stage'));

    const ids = ['agent-stage', 'first-stage'];
    expect((await store.listDocuments()).map((summary) => summary.id)).toEqual(ids);
    expect((await agnostic.listDocuments()).map((summary) => summary.id)).toEqual(ids);
  });

  test('requires a transaction hook at construction time', () => {
    expect(() => new PgDocumentStore(db, {} as PgDocumentStoreOptions)).toThrow(
      /withTransaction.*fresh.*connection.*transaction/i,
    );
  });

  test('saveDocument uses one transaction and locks the existing stage before replacement', async () => {
    await store.saveDocument(makeDocument());
    let transactionCalls = 0;
    const sql: string[] = [];
    const instrumented = new PgDocumentStore(db, {
      withTransaction: (body) => {
        transactionCalls += 1;
        return db.transaction((tx: Queryable) =>
          body({
            async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
              text: string,
              params?: unknown[],
            ): Promise<QueryResult<TRow>> {
              sql.push(text);
              return tx.query<TRow>(text, params);
            },
          }),
        );
      },
    });
    const replacement = makeDocument();
    replacement.scenes = [slideScene('stage-1', 'scene-a', 0, 'Edited')];
    delete replacement.outline;

    await instrumented.saveDocument(replacement);

    expect(transactionCalls).toBe(1);
    // A write transaction opens with its lock-wait budget: these take the
    // stage row's lock, and with reference tracking on, rows the asset
    // collector locks too, so an unbounded wait would hang the write.
    expect(sql[0]).toBe("SET LOCAL lock_timeout = '30s'");
    expect(sql[1]).toMatch(/document_stages[\s\S]*FOR UPDATE/);
    expect(sql.some((statement) => statement.includes('ON CONFLICT (id) DO UPDATE'))).toBe(true);
    expect(sql.some((statement) => statement.includes('DELETE FROM document_scenes'))).toBe(true);
    expect(sql.some((statement) => statement.includes('DELETE FROM document_outlines'))).toBe(true);
  });

  test('incremental writes lock the stage row and reject stale and future versions', async () => {
    await store.saveDocument(makeDocument());

    await restamp(db, 'stage-1', undefined);
    const staleFailure = store.putScene('stage-1', slideScene('stage-1', 'stale', 2));
    await expect(staleFailure).rejects.toBeInstanceOf(DocumentVersionError);
    await expect(staleFailure).rejects.toMatchObject({
      kind: 'not-current',
      storedVersion: undefined,
    });
    await expect(staleFailure).rejects.toThrow(/load and save/);
    await expect(
      store.putStage('stage-1', {
        id: 'stage-1',
        name: 'Stale',
        createdAt: 1000,
        updatedAt: 3000,
      }),
    ).rejects.toThrow(/load and save/);
    await expect(store.deleteScene('stage-1', 'scene-a')).rejects.toThrow(/load and save/);

    await restamp(db, 'stage-1', '99.0.0');
    const futureFailure = store.putScene('stage-1', slideScene('stage-1', 'future', 2));
    await expect(futureFailure).rejects.toBeInstanceOf(DocumentVersionError);
    await expect(futureFailure).rejects.toMatchObject({
      kind: 'not-current',
      storedVersion: '99.0.0',
    });
    await expect(futureFailure).rejects.toThrow(/load and save/);
    await expect(store.deleteScene('stage-1', 'scene-a')).rejects.toThrow(/load and save/);
  });

  test('missing incremental-write parents use DocumentNotFoundError', async () => {
    const failure = store.putScene('ghost', slideScene('ghost', 'scene', 0));
    await expect(failure).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(failure).rejects.toMatchObject({ stageId: 'ghost' });
  });

  test('loadDocument migrates legacy data without writing the new stamp back', async () => {
    await store.saveDocument(makeDocument());
    await restamp(db, 'stage-1', undefined);

    expect((await store.loadDocument('stage-1'))!.dslVersion).toBe(DSL_VERSION);
    const stored = await db.query<{ data: unknown }>(
      'SELECT data FROM document_stages WHERE id = $1',
      ['stage-1'],
    );
    expect(stored.rows[0]!.data).not.toHaveProperty('dslVersion');
  });

  test('listDocuments uses metadata columns and tolerates corrupt content/version data', async () => {
    await store.saveDocument(makeDocument());
    await db.query(`UPDATE document_stages SET data = '"not-an-object"'::jsonb WHERE id = $1`, [
      'stage-1',
    ]);

    await expect(store.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'stage-1', name: 'Intro Course', sceneCount: 2 }),
    ]);
    await expect(store.loadDocument('stage-1')).rejects.toThrow(/corrupt stored row/);
  });

  test('rejects JSONB-lossy stage, scene, and outline values before writing', async () => {
    const stageLoss = makeDocument('stage-stage-loss');
    Object.assign(stageLoss.stage, { extension: new Date('2026-01-01T00:00:00.000Z') });
    await expect(store.saveDocument(stageLoss)).rejects.toThrow(/plain JSON value.*Date/i);

    const sceneLoss = makeDocument('stage-scene-loss');
    Object.assign(sceneLoss.scenes[0]!, { extension: new Map([['x', 1]]) });
    await expect(store.saveDocument(sceneLoss)).rejects.toThrow(/plain JSON value.*Map/i);

    const outlineLoss = makeDocument('stage-outline-loss');
    outlineLoss.outline = { nested: { missing: undefined } };
    await expect(store.saveDocument(outlineLoss)).rejects.toThrow(/undefined member/i);
  });

  test('deleteDocument is one direct statement and relies on FK cascades', async () => {
    await store.saveDocument(makeDocument());
    let transactionCalls = 0;
    const directDeleteStore = new PgDocumentStore(db, {
      withTransaction: (body) => {
        transactionCalls += 1;
        return db.transaction((tx: Queryable) => body(tx));
      },
    });

    await directDeleteStore.deleteDocument('stage-1');

    expect(transactionCalls).toBe(0);
    expect((await db.query('SELECT * FROM document_scenes')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM document_outlines')).rows).toEqual([]);
  });
});
