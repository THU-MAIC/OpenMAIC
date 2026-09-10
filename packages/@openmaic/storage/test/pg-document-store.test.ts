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
    store = new PgDocumentStore(db, transactionOptions(db)).forOwner('anon:contract-owner');
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
    const root = new PgDocumentStore(db, transactionOptions(db));
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

  test('ensureDocumentSchema adds the nullable owner column to an existing stage table', async () => {
    const legacy = new PGlite();
    await legacy.waitReady;
    try {
      await legacy.query(`CREATE TABLE document_stages (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        interactive_mode BOOLEAN,
        task_engine_mode BOOLEAN,
        created_at DOUBLE PRECISION NOT NULL,
        updated_at DOUBLE PRECISION NOT NULL,
        data JSONB NOT NULL
      )`);
      await ensureDocumentSchema(legacy);
      const columns = await legacy.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'document_stages' AND column_name = 'owner_id'`,
      );
      expect(columns.rows).toEqual([{ column_name: 'owner_id', is_nullable: 'YES' }]);
    } finally {
      await legacy.close();
    }
  });

  test('owner scopes filter lists and writes while reads remain capability-by-id', async () => {
    const alice = store.forOwner('anon:alice');
    const bob = store.forOwner('anon:bob');
    await alice.saveDocument(makeDocument('alice-stage'));
    await bob.saveDocument(makeDocument('bob-stage'));

    await expect(alice.loadDocument('bob-stage')).resolves.toMatchObject({
      stage: { id: 'bob-stage' },
    });
    await expect(bob.getScene('alice-stage', 'scene-a')).resolves.toMatchObject({
      stageId: 'alice-stage',
    });
    await expect(alice.listDocuments()).resolves.toEqual([
      expect.objectContaining({ id: 'alice-stage' }),
    ]);
    await expect(bob.saveDocument(makeDocument('alice-stage'))).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );

    await bob.deleteDocument('alice-stage');
    await expect(alice.loadDocument('alice-stage')).resolves.not.toBeNull();
  });

  test('the historical unowned path remains byte-identical beside owned documents', async () => {
    const legacyDocument = makeDocument('legacy-stage');
    await store.saveDocument(legacyDocument);
    const beforeDocument = JSON.stringify(await store.loadDocument('legacy-stage'));
    const beforeList = JSON.stringify(await store.listDocuments());
    const beforeRows = JSON.stringify(
      (
        await db.query<{ data: unknown }>(
          'SELECT data FROM document_stages WHERE id = $1 AND owner_id IS NULL',
          ['legacy-stage'],
        )
      ).rows,
    );

    await store.forOwner('anon:agent').saveDocument(makeDocument('agent-stage'));

    expect(JSON.stringify(await store.loadDocument('legacy-stage'))).toBe(beforeDocument);
    expect(JSON.stringify(await store.listDocuments())).toBe(beforeList);
    expect(
      JSON.stringify(
        (
          await db.query<{ data: unknown }>(
            'SELECT data FROM document_stages WHERE id = $1 AND owner_id IS NULL',
            ['legacy-stage'],
          )
        ).rows,
      ),
    ).toBe(beforeRows);
    await expect(store.loadDocument('agent-stage')).resolves.toMatchObject({
      stage: { id: 'agent-stage' },
    });
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
    expect(sql[0]).toMatch(/document_stages[\s\S]*FOR UPDATE/);
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
