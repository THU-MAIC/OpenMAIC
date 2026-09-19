import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '../src/agent-session/pg.js';
import {
  DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES,
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '../src/material/pg.js';
import { runAgentSessionMaterialContract } from './agent-session-material-contract.js';

function combinedStore(db: PGlite) {
  const sessionStore = new PgAgentSessionStore(db, {
    withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
  });
  // Advancing clock so rapid successive creates get strictly increasing
  // timestamps; `new Date()` has only millisecond precision and would make
  // ordering assertions flaky on ties (which resolve by id DESC instead).
  let tick = 0;
  const materialStore = new PgAgentSessionMaterialStore(db, {
    now: () => new Date(1_700_000_000_000 + (tick += 1_000)),
  });
  return {
    createSession: (input: Parameters<typeof sessionStore.createSession>[0]) =>
      sessionStore.createSession(input),
    createMaterial: materialStore.createMaterial.bind(materialStore),
    listMaterials: materialStore.listMaterials.bind(materialStore),
    getMaterial: materialStore.getMaterial.bind(materialStore),
    enqueueExtraction: materialStore.enqueueExtraction.bind(materialStore),
    claimNextExtraction: materialStore.claimNextExtraction.bind(materialStore),
    heartbeatExtraction: materialStore.heartbeatExtraction.bind(materialStore),
    completeExtraction: materialStore.completeExtraction.bind(materialStore),
    settleExtractionFailure: materialStore.settleExtractionFailure.bind(materialStore),
  };
}

describe('PgAgentSessionMaterialStore with PGlite', () => {
  let db: PGlite;
  let store: PgAgentSessionMaterialStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    // The material table references agent_sessions(id), so the agent-session
    // schema must be provisioned first (the same host-side ordering).
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    store = new PgAgentSessionMaterialStore(db);
  });

  afterEach(async () => {
    await db.close();
  });

  runAgentSessionMaterialContract('Postgres (PGlite)', () => combinedStore(db));

  test('provisions the material table idempotently', async () => {
    await expect(ensureAgentSessionMaterialSchema(db)).resolves.toBeUndefined();
    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [Object.values(DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES)],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual(
      Object.values(DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES).sort(),
    );
  });

  test('adds owner_material_id to a table provisioned before the column existed', async () => {
    // Simulate a 1.0.2 database: the table predates the owner-material column,
    // so `CREATE TABLE IF NOT EXISTS` cannot add it. CASCADE also drops the
    // partial unique index that depends on the column.
    await db.query('ALTER TABLE agent_session_materials DROP COLUMN owner_material_id CASCADE');
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-legacy', ownerId: 'owner-a', prompt: 'p' });
    await db.query(
      `INSERT INTO agent_session_materials
         (id, session_id, kind, title, text_chars, extraction_status, extraction_attempts, created_at)
       VALUES ('mat_legacy', 'session-legacy', 'web', 'legacy', 0, 'done', 0, now())`,
    );

    // Re-running the initializer is the in-place upgrade.
    await ensureAgentSessionMaterialSchema(db);

    const legacy = await store.getMaterial('session-legacy', 'mat_legacy');
    expect(legacy).toMatchObject({ id: 'mat_legacy', ownerMaterialId: null });

    // The upgraded table now accepts two sessions binding one owner upload.
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'p' });
    await sessions.createSession({ id: 'session-b', ownerId: 'owner-a', prompt: 'p' });
    const first = await store.createMaterial('session-a', {
      kind: 'source',
      title: 'textbook.pdf',
      ownerMaterialId: 'mat_owner',
    });
    const second = await store.createMaterial('session-b', {
      kind: 'source',
      title: 'textbook.pdf',
      ownerMaterialId: 'mat_owner',
    });
    expect(first.id).not.toBe(second.id);
    expect(first.ownerMaterialId).toBe('mat_owner');
    expect(second.ownerMaterialId).toBe('mat_owner');
  });

  test('backfills owner_material_id onto a legacy row without touching extraction', async () => {
    await new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    }).createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    // The pre-upgrade binder's shape: id = owner id, owner_material_id NULL.
    await db.query(
      `INSERT INTO agent_session_materials
         (id, session_id, kind, title, raw_asset_id, text_chars, extraction_status,
          extraction_attempts, extractor_version, created_at)
       VALUES ('mat_owner', 'session-1', 'source', 'textbook.pdf',
               'materials/session-1/mat_owner/raw.x', 0, 'done', 2, 'pdf@1', now())`,
    );

    const backfilled = await store.backfillOwnerMaterialId('session-1', 'mat_owner', 'mat_owner');
    expect(backfilled).toMatchObject({
      id: 'mat_owner',
      ownerMaterialId: 'mat_owner',
      rawAssetId: 'materials/session-1/mat_owner/raw.x',
      extraction: { status: 'done', attempts: 2, extractorVersion: 'pdf@1' },
    });
    // The NULL predicate means a repeat is a no-op, not an error.
    expect(await store.backfillOwnerMaterialId('session-1', 'mat_owner', 'mat_owner')).toBeNull();
    expect(await store.backfillOwnerMaterialId('session-1', 'mat_absent', 'mat_absent')).toBeNull();
  });

  test('cascades material rows away when the session row is hard-deleted', async () => {
    await new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    }).createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { kind: 'web', sourceUrl: 'https://example.com/' });

    await db.query('DELETE FROM agent_sessions WHERE id = $1', ['session-1']);

    expect(await store.listMaterials('session-1')).toEqual([]);
  });

  test('fails closed for soft-deleted sessions on create, list, and read', async () => {
    const sessionStore = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const material = await store.createMaterial('session-1', {
      kind: 'web',
      sourceUrl: 'https://example.com/',
    });

    await sessionStore.softDeleteSession('session-1', 'owner-a');

    await expect(store.getMaterial('session-1', material.id)).resolves.toBeNull();
    await expect(store.listMaterials('session-1')).resolves.toEqual([]);
    await expect(store.createMaterial('session-1', { kind: 'web' })).rejects.toMatchObject({
      code: 'session_missing',
    });
  });

  test('honours the table-name override for the material table', async () => {
    const overrideDb = new PGlite();
    await overrideDb.waitReady;
    await ensureAgentSessionSchema(overrideDb);
    await ensureAgentSessionMaterialSchema(overrideDb, { materials: 'custom_materials' });
    const overridden = new PgAgentSessionMaterialStore(overrideDb, {
      tableNames: { materials: 'custom_materials' },
    });
    await new PgAgentSessionStore(overrideDb, {
      withTransaction: (body) => overrideDb.transaction((tx: Queryable) => body(tx)),
    }).createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });

    const material = await overridden.createMaterial('session-1', {
      kind: 'web',
      sourceUrl: 'https://example.com/',
    });

    expect((await overridden.getMaterial('session-1', material.id))?.id).toBe(material.id);
    // Only the overridden table was created; the default one stays absent.
    const tables = await overrideDb.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [['custom_materials', 'agent_session_materials']],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(['custom_materials']);
    await overrideDb.close();
  });

  test('rejects an invalid table-name override', () => {
    expect(
      () => new PgAgentSessionMaterialStore(db, { tableNames: { materials: 'Bad Name' } }),
    ).toThrow(/invalid agent-session-material table name/);
  });

  test('runs idle -> pending -> running -> done and creates the readable derivative', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const source = await store.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      title: 'notes.txt',
      rawAssetId: 'ast_raw',
    });
    expect(source.extraction).toEqual({ status: 'idle', attempts: 0 });

    expect(await store.enqueueExtraction('session-1', source.id)).toBe(true);
    expect((await store.getMaterial('session-1', source.id))?.extraction.status).toBe('pending');
    const claim = await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    expect(claim?.material.extraction.status).toBe('running');
    expect(await store.heartbeatExtraction(source.id, 'worker-a')).toBe(true);

    expect(
      await store.completeExtraction({
        sourceId: source.id,
        workerId: 'worker-a',
        extractorVersion: 'plain-text@1',
        stats: { chars: 12, pages: 0, imageCount: 0 },
        derived: {
          id: 'mat_extracted',
          kind: 'extraction',
          title: 'notes.extracted.md',
          textAssetId: 'ast_text',
          textChars: 12,
        },
      }),
    ).toBe(true);
    expect((await store.getMaterial('session-1', source.id))?.extraction).toMatchObject({
      status: 'done',
      stats: { chars: 12 },
      extractorVersion: 'plain-text@1',
    });
    expect(await store.getMaterial('session-1', 'mat_extracted')).toMatchObject({
      kind: 'extraction',
      derivedFrom: source.id,
      textAssetId: 'ast_text',
      extraction: { status: 'done' },
    });
  });

  test('persists extraction stats containing NUL and lone surrogates', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const source = await store.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      title: 'notes.txt',
    });
    await store.enqueueExtraction('session-1', source.id);
    await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });

    expect(
      await store.completeExtraction({
        sourceId: source.id,
        workerId: 'worker-a',
        extractorVersion: 'plain-text@1',
        stats: {
          chars: 5,
          pages: 0,
          imageCount: 0,
          diagnostics: [`bad\u0000diag`, `bad\uD800diag`],
        },
        derived: {
          id: 'mat_extracted',
          kind: 'extraction',
          textAssetId: 'ast_text',
          textChars: 5,
        },
      }),
    ).toBe(true);

    expect((await store.getMaterial('session-1', source.id))?.extraction.stats).toMatchObject({
      diagnostics: ['bad\uFFFDdiag', 'bad\uFFFDdiag'],
    });
  });

  test('reclaims an expired running lease and fences the previous worker', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });
    await store.enqueueExtraction('session-1', 'mat_source');

    let now = 1_700_000_000_000;
    const leased = new PgAgentSessionMaterialStore(db, { now: () => new Date(now) });
    expect(await leased.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 })).not.toBeNull();
    now += 9_999;
    expect(await leased.claimNextExtraction('worker-b', { leaseTtlMs: 10_000 })).toBeNull();
    now += 2;
    expect(await leased.claimNextExtraction('worker-b', { leaseTtlMs: 10_000 })).not.toBeNull();
    expect(await leased.heartbeatExtraction('mat_source', 'worker-a')).toBe(false);
    expect(await leased.heartbeatExtraction('mat_source', 'worker-b')).toBe(true);
  });

  test('keeps terminal states terminal and permits only an explicit failed retry', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });
    await store.enqueueExtraction('session-1', 'mat_source');
    await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    expect(
      await store.settleExtractionFailure('mat_source', 'worker-a', 'permanent failure', false),
    ).toEqual({ status: 'failed', attempts: 0 });
    expect(await store.claimNextExtraction('worker-b', { leaseTtlMs: 10_000 })).toBeNull();

    expect(await store.enqueueExtraction('session-1', 'mat_source')).toBe(true);
    expect(await store.enqueueExtraction('session-1', 'mat_source')).toBe(false);
    await store.claimNextExtraction('worker-b', { leaseTtlMs: 10_000 });
    await store.completeExtraction({
      sourceId: 'mat_source',
      workerId: 'worker-b',
      extractorVersion: 'plain-text@1',
      stats: { chars: 1, pages: 0, imageCount: 0 },
      derived: {
        id: 'mat_extracted',
        kind: 'extraction',
        textAssetId: 'ast_text',
        textChars: 1,
      },
    });
    expect(await store.enqueueExtraction('session-1', 'mat_source')).toBe(false);
    expect(await store.claimNextExtraction('worker-c', { leaseTtlMs: 10_000 })).toBeNull();
  });

  test('automatically retries a transient failure twice, then becomes failed', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });
    await store.enqueueExtraction('session-1', 'mat_source');

    for (const expected of [1, 2]) {
      await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
      expect(
        await store.settleExtractionFailure('mat_source', 'worker-a', 'temporary', true),
      ).toEqual({ status: 'pending', attempts: expected });
    }
    await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    expect(
      await store.settleExtractionFailure('mat_source', 'worker-a', 'still broken', true),
    ).toEqual({ status: 'failed', attempts: 2 });
  });
});
