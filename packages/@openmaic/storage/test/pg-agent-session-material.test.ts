import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
    deleteMaterial: materialStore.deleteMaterial.bind(materialStore),
    getDeletedSessionMaterialsForCleanup:
      materialStore.getDeletedSessionMaterialsForCleanup.bind(materialStore),
    purgeDeletedSessionMaterials: materialStore.purgeDeletedSessionMaterials.bind(materialStore),
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
    store = new PgAgentSessionMaterialStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
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

  test('adds the durable write-claim table to an existing material schema', async () => {
    await db.query('DROP TABLE agent_session_material_write_claims');

    await expect(ensureAgentSessionMaterialSchema(db)).resolves.toBeUndefined();

    const result = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1`,
      [DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.writeClaims],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      DEFAULT_AGENT_SESSION_MATERIAL_TABLE_NAMES.writeClaims,
    ]);
  });

  test('moves a durable byte-write claim through claimed, staged, and finalized', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const claim = await store.claimMaterialWrite('session-1', {
      materialId: 'mat_claimed',
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey: 'materials/session-1/mat_claimed/raw.bin',
    });
    expect(claim).toMatchObject({ state: 'claimed', sessionId: 'session-1' });

    let writes = 0;
    await expect(
      store.executeClaimedMaterialWrite(claim.id, async () => {
        writes += 1;
      }),
    ).resolves.toBe(true);
    expect(writes).toBe(1);
    await store.createMaterial('session-1', {
      id: 'mat_claimed',
      kind: 'source',
      rawAssetId: claim.objectKey,
    });
    await expect(store.finalizeMaterialWrite('session-1', claim.id)).resolves.toBe(true);
    await expect(store.finalizeMaterialWrite('session-1', claim.id)).resolves.toBe(false);
  });

  test('retains a failed publish claim for tombstone cleanup and rejects all later writes', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const claim = await store.claimMaterialWrite('session-1', {
      materialId: 'mat_crashed',
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey: 'materials/session-1/mat_crashed/raw.bin',
    });
    await expect(
      store.executeClaimedMaterialWrite(claim.id, async () => {
        throw new Error('publish crashed');
      }),
    ).rejects.toThrow('publish crashed');
    await sessions.softDeleteSession('session-1', 'owner-a');

    await expect(
      store.getDeletedSessionMaterialWriteClaimsForCleanup('session-1', 'owner-b'),
    ).resolves.toBeNull();
    await expect(
      store.getDeletedSessionMaterialWriteClaimsForCleanup('session-1', 'owner-a'),
    ).resolves.toEqual([expect.objectContaining({ id: claim.id, state: 'claimed' })]);
    const write = vi.fn();
    await expect(store.executeClaimedMaterialWrite(claim.id, write)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
    await expect(
      store.claimMaterialWrite('session-1', {
        materialId: 'mat_too_late',
        materialKind: 'source',
        objectSlot: 'raw',
        objectKey: 'materials/session-1/mat_too_late/raw.bin',
      }),
    ).rejects.toMatchObject({ code: 'session_missing' });
    await expect(
      store.purgeDeletedSessionMaterialWriteClaims('session-1', 'owner-b'),
    ).resolves.toBe(false);
    await expect(
      store.purgeDeletedSessionMaterialWriteClaims('session-1', 'owner-a'),
    ).resolves.toBe(true);
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

  test('rejects a derivative whose source belongs to another session', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await sessions.createSession({ id: 'session-2', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });

    await expect(
      store.createMaterial('session-2', {
        id: 'mat_foreign_derivative',
        kind: 'extraction',
        derivedFrom: 'mat_source',
      }),
    ).rejects.toBeDefined();
    expect(await store.getMaterial('session-1', 'mat_source')).not.toBeNull();
    expect(await store.listMaterials('session-2')).toEqual([]);
  });

  test('exposes cleanup rows only for the owner of a soft-deleted session', async () => {
    const sessionStore = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    const material = await store.createMaterial('session-1', {
      id: 'mat_cleanup',
      kind: 'source',
      rawAssetId: 'materials/session-1/mat_cleanup/raw.bin',
    });
    expect(await store.getDeletedSessionMaterialsForCleanup('session-1', 'owner-a')).toBeNull();
    await sessionStore.softDeleteSession('session-1', 'owner-a');
    expect(await store.getDeletedSessionMaterialsForCleanup('session-1', 'owner-b')).toBeNull();
    await expect(
      store.getDeletedSessionMaterialsForCleanup('session-1', 'owner-a'),
    ).resolves.toEqual([material]);
    expect(await store.purgeDeletedSessionMaterials('session-1', 'owner-b')).toBe(false);
    expect(await store.purgeDeletedSessionMaterials('session-1', 'owner-a')).toBe(true);
    expect(await store.getDeletedSessionMaterialsForCleanup('session-1', 'owner-a')).toEqual([]);
    expect(await store.purgeDeletedSessionMaterials('session-1', 'owner-a')).toBe(false);
  });

  test('fences extraction completion after the owning session is tombstoned', async () => {
    const sessionStore = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessionStore.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });
    await store.enqueueExtraction('session-1', 'mat_source');
    await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    await sessionStore.softDeleteSession('session-1', 'owner-a');

    await expect(
      store.completeExtraction({
        sourceId: 'mat_source',
        workerId: 'worker-a',
        extractorVersion: 'plain@1',
        stats: { chars: 1, pages: 0, imageCount: 0 },
        derived: {
          id: 'mat_derived',
          kind: 'extraction',
          textAssetId: 'materials/session-1/mat_derived/text.md',
          textChars: 1,
        },
      }),
    ).resolves.toBe(false);
    expect(await store.getDeletedSessionMaterialsForCleanup('session-1', 'owner-a')).toEqual([
      expect.objectContaining({ id: 'mat_source', derivedFrom: null }),
    ]);
  });

  test('honours the table-name override for the material table', async () => {
    const overrideDb = new PGlite();
    await overrideDb.waitReady;
    await ensureAgentSessionSchema(overrideDb);
    await ensureAgentSessionMaterialSchema(overrideDb, { materials: 'custom_materials' });
    const overridden = new PgAgentSessionMaterialStore(overrideDb, {
      tableNames: { materials: 'custom_materials' },
      withTransaction: (body) => overrideDb.transaction((tx: Queryable) => body(tx)),
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
       WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
      [
        [
          'custom_materials',
          'custom_materials_write_claims',
          'agent_session_materials',
          'agent_session_material_write_claims',
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'custom_materials',
      'custom_materials_write_claims',
    ]);
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

  test('a fenced stale completion cannot delete the winning derivative', async () => {
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-a', prompt: 'p' });
    await store.createMaterial('session-1', { id: 'mat_source', kind: 'source' });
    await store.enqueueExtraction('session-1', 'mat_source');

    let now = 1_700_000_000_000;
    const leased = new PgAgentSessionMaterialStore(db, { now: () => new Date(now) });
    await leased.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    now += 10_001;
    await leased.claimNextExtraction('worker-b', { leaseTtlMs: 10_000 });
    expect(
      await leased.completeExtraction({
        sourceId: 'mat_source',
        workerId: 'worker-b',
        extractorVersion: 'winner@1',
        stats: { chars: 6, pages: 0, imageCount: 0 },
        derived: {
          id: 'mat_winner',
          kind: 'extraction',
          textAssetId: 'winner.txt',
          textChars: 6,
        },
      }),
    ).toBe(true);

    expect(
      await leased.completeExtraction({
        sourceId: 'mat_source',
        workerId: 'worker-a',
        extractorVersion: 'stale@1',
        stats: { chars: 5, pages: 0, imageCount: 0 },
        derived: {
          id: 'mat_stale',
          kind: 'extraction',
          textAssetId: 'stale.txt',
          textChars: 5,
        },
      }),
    ).toBe(false);
    expect(await leased.getMaterial('session-1', 'mat_winner')).toMatchObject({
      derivedFrom: 'mat_source',
      textAssetId: 'winner.txt',
    });
    expect(await leased.getMaterial('session-1', 'mat_stale')).toBeNull();
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
      await store.settleExtractionFailure(
        'mat_source',
        'worker-a',
        'MATERIAL_EXTRACTION_FAILED',
        false,
      ),
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
        await store.settleExtractionFailure(
          'mat_source',
          'worker-a',
          'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
          true,
        ),
      ).toEqual({ status: 'pending', attempts: expected });
    }
    await store.claimNextExtraction('worker-a', { leaseTtlMs: 10_000 });
    expect(
      await store.settleExtractionFailure(
        'mat_source',
        'worker-a',
        'MATERIAL_EXTRACTION_PROVIDER_UNAVAILABLE',
        true,
      ),
    ).toEqual({ status: 'failed', attempts: 2 });
  });
});
