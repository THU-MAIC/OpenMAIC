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
          AND table_name IN ('document_stages', 'document_scenes', 'document_outlines')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'document_outlines',
      'document_scenes',
      'document_stages',
    ]);
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
