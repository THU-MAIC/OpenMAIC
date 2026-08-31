import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureAgentSessionSchema,
  PgAgentSessionStore,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';
import {
  ensureAgentSessionMaterialSchema,
  PgAgentSessionMaterialStore,
} from '@openmaic/storage/material/pg';

import { ensureOwnerMaterialSchema } from '@/lib/persistence/owner-materials';
import {
  bindOwnerMaterialsToSession,
  boundSessionMaterialId,
  cleanupDeletedSessionMaterials,
  deleteOwnedSessionWithMaterials,
  finalizeSessionMaterialObjectWrite,
  removeSessionMaterialRawAsset,
  resolveSessionMaterialRawAsset,
  SessionMaterialBindingError,
  storeSessionMaterialRawAsset,
} from '@/lib/server/agent-runtime/session-materials';
import {
  LocalMaterialByteStore,
  setMaterialByteStoreForTests,
  type MaterialByteStore,
} from '@/lib/server/materials/bytes';
import {
  ownerMaterialObjectKey,
  sessionMaterialObjectKey,
  sessionMaterialObjectPrefix,
} from '@/lib/server/materials/object-keys';
import { deleteOwnedMaterial } from '@/lib/server/materials/owner-assets';

const OWNER_MATERIAL_A = `mat_${'0'.repeat(26)}`;
const OWNER_MATERIAL_B = `mat_${'1'.repeat(26)}`;

describe('owner material session snapshot lifecycle', () => {
  let db: PGlite;
  let sessions: PgAgentSessionStore;
  let materials: PgAgentSessionMaterialStore;
  let objects: Map<string, Buffer>;
  let byteStore: MaterialByteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    await ensureOwnerMaterialSchema(db);
    sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    materials = new PgAgentSessionMaterialStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    objects = new Map();
    byteStore = {
      put: async (key, body) => void objects.set(key, Buffer.from(body as Uint8Array)),
      get: async (key) => {
        const value = objects.get(key);
        if (!value) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return Buffer.from(value);
      },
      delete: async (key) => void objects.delete(key),
      deletePrefix: async (prefix) => {
        for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
      },
    };
    setMaterialByteStoreForTests(byteStore);
  });

  afterEach(async () => {
    setMaterialByteStoreForTests(null);
    await db.close();
  });

  const bindDependencies = () => ({
    queryable: db,
    byteStore,
    sessionStore: sessions,
    materialStore: materials,
  });

  const cleanupDependencies = () => ({
    byteStore,
    sessionStore: sessions,
    materialStore: materials,
  });

  async function insertOwnerMaterial(
    ownerId: string,
    materialId: string,
    body = Buffer.from(`bytes:${materialId}`),
  ) {
    const ossKey = ownerMaterialObjectKey(ownerId, materialId);
    objects.set(ossKey, Buffer.from(body));
    await db.query(
      `INSERT INTO owner_material
         (id, owner_id, kind, mime, bytes, original_name, oss_key, sha256,
          status, extraction, created_at)
       VALUES ($1, $2, 'source', 'application/pdf', $3, $4, $5, $6,
               'ready', '{"status":"idle"}'::jsonb, $7)`,
      [
        materialId,
        ownerId,
        body.byteLength,
        `${materialId}.pdf`,
        ossKey,
        createHash('sha256').update(body).digest('hex'),
        Date.now(),
      ],
    );
    return { body, ossKey };
  }

  it('binds independent idempotent snapshots to two sessions and deleting A preserves B', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await sessions.createSession({ id: 'session-b', ownerId: 'owner-a', prompt: 'b' });
    const { body, ossKey: ownerKey } = await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);

    const [boundA] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    const [boundB] = await bindOwnerMaterialsToSession(
      'session-b',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    expect(boundA!.materialId).toBe(boundSessionMaterialId('session-a', OWNER_MATERIAL_A));
    expect(boundB!.materialId).toBe(boundSessionMaterialId('session-b', OWNER_MATERIAL_A));
    expect(boundA!.materialId).not.toBe(boundB!.materialId);

    const rowA = await materials.getMaterial('session-a', boundA!.materialId);
    const rowB = await materials.getMaterial('session-b', boundB!.materialId);
    expect(rowA?.rawAssetId).not.toBe(rowB?.rawAssetId);
    expect(rowA?.rawAssetId).not.toContain('session-a');
    expect(rowB?.rawAssetId).not.toContain('session-b');
    expect(objects.get(rowA!.rawAssetId!)).toEqual(body);
    expect(objects.get(rowB!.rawAssetId!)).toEqual(body);
    await expect(
      resolveSessionMaterialRawAsset('session-a', rowB!.rawAssetId!),
    ).resolves.toBeNull();
    await expect(
      resolveSessionMaterialRawAsset('session-b', rowB!.rawAssetId!),
    ).resolves.toMatchObject({
      bytes: body,
      mime: 'application/pdf',
    });
    const orphanInA = rowA!.rawAssetId!.replace(/\/[^/]+$/, '/crash-orphan.bin');
    objects.set(orphanInA, Buffer.from('untracked'));

    const [rebound] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    expect(rebound!.materialId).toBe(boundA!.materialId);
    expect(await materials.listMaterials('session-a')).toHaveLength(1);

    await expect(
      deleteOwnedSessionWithMaterials('session-a', 'owner-a', cleanupDependencies()),
    ).resolves.toBe(true);
    expect(objects.has(rowA!.rawAssetId!)).toBe(false);
    expect(objects.has(orphanInA)).toBe(false);
    expect(objects.has(rowB!.rawAssetId!)).toBe(true);
    expect(objects.has(ownerKey)).toBe(true);
    expect(await materials.getMaterial('session-b', boundB!.materialId)).not.toBeNull();
    expect(await byteStore.get(rowB!.rawAssetId!)).toEqual(body);
    await expect(
      deleteOwnedSessionWithMaterials('session-a', 'owner-a', cleanupDependencies()),
    ).resolves.toBe(true);
  });

  it('owner deletion leaves already-bound session snapshots readable', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    const [bound] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    const row = await materials.getMaterial('session-a', bound!.materialId);

    await deleteOwnedMaterial('owner-a', OWNER_MATERIAL_A, { queryable: db, byteStore });

    expect(await byteStore.get(row!.rawAssetId!)).toEqual(Buffer.from(`bytes:${OWNER_MATERIAL_A}`));
    expect(await materials.getMaterial('session-a', bound!.materialId)).not.toBeNull();
  });

  it('converges concurrent repeated binds on one session snapshot', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);

    const [first, second] = await Promise.all([
      bindOwnerMaterialsToSession('session-a', 'owner-a', [OWNER_MATERIAL_A], bindDependencies()),
      bindOwnerMaterialsToSession('session-a', 'owner-a', [OWNER_MATERIAL_A], bindDependencies()),
    ]);

    expect(first).toEqual(second);
    expect(await materials.listMaterials('session-a')).toHaveLength(1);
  });

  it('keeps committed partial progress when a later item fails', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    const first = await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_B);
    const createMaterial = vi
      .fn(materials.createMaterial.bind(materials))
      .mockImplementationOnce(materials.createMaterial.bind(materials))
      .mockRejectedValueOnce(new Error('metadata write failed'));

    await expect(
      bindOwnerMaterialsToSession('session-a', 'owner-a', [OWNER_MATERIAL_A, OWNER_MATERIAL_B], {
        ...bindDependencies(),
        materialStore: {
          claimMaterialWrite: materials.claimMaterialWrite.bind(materials),
          createMaterial,
          deleteMaterial: materials.deleteMaterial.bind(materials),
          discardMaterialWrite: materials.discardMaterialWrite.bind(materials),
          executeClaimedMaterialWrite: materials.executeClaimedMaterialWrite.bind(materials),
          finalizeMaterialWrite: materials.finalizeMaterialWrite.bind(materials),
          getMaterial: materials.getMaterial.bind(materials),
        },
      }),
    ).rejects.toBeInstanceOf(SessionMaterialBindingError);

    const committedId = boundSessionMaterialId('session-a', OWNER_MATERIAL_A);
    const committed = await materials.getMaterial('session-a', committedId);
    expect(committed).not.toBeNull();
    expect(await byteStore.get(committed!.rawAssetId!)).toEqual(first.body);
  });

  it('removes source and derivative objects when their session is deleted', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    const [bound] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    const textKey = sessionMaterialObjectKey('session-a', 'derived-a', 'derived.txt');
    const rawKey = sessionMaterialObjectKey('session-a', 'derived-a', 'derived.bin');
    objects.set(textKey, Buffer.from('text'));
    objects.set(rawKey, Buffer.from('raw'));
    await materials.createMaterial('session-a', {
      id: 'derived-a',
      kind: 'extraction',
      derivedFrom: bound!.materialId,
      textAssetId: textKey,
      rawAssetId: rawKey,
      textChars: 4,
    });

    await expect(
      deleteOwnedSessionWithMaterials('session-a', 'owner-a', cleanupDependencies()),
    ).resolves.toBe(true);
    expect(objects.has(textKey)).toBe(false);
    expect(objects.has(rawKey)).toBe(false);
  });

  it('rejects canonical-prefix traversal for raw reads and compensation deletes', async () => {
    const traversal = `${sessionMaterialObjectPrefix('session-a')}../session-b/private.bin`;
    objects.set(traversal, Buffer.from('foreign'));

    await expect(resolveSessionMaterialRawAsset('session-a', traversal)).resolves.toBeNull();
    await expect(removeSessionMaterialRawAsset('session-a', traversal)).resolves.toBeUndefined();
    expect(objects.get(traversal)).toEqual(Buffer.from('foreign'));
  });

  it('denies a foreign owner material and a foreign target session before copying bytes', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await sessions.createSession({ id: 'session-b', ownerId: 'owner-b', prompt: 'b' });
    const { ossKey } = await insertOwnerMaterial('owner-b', OWNER_MATERIAL_B);

    await expect(
      bindOwnerMaterialsToSession('session-a', 'owner-a', [OWNER_MATERIAL_B], bindDependencies()),
    ).rejects.toBeInstanceOf(SessionMaterialBindingError);
    await expect(
      bindOwnerMaterialsToSession('session-b', 'owner-a', [OWNER_MATERIAL_B], bindDependencies()),
    ).rejects.toBeInstanceOf(SessionMaterialBindingError);
    expect(await materials.listMaterials('session-a')).toEqual([]);
    expect(await materials.listMaterials('session-b')).toEqual([]);
    expect(
      await materials.enqueueExtraction(
        'session-a',
        boundSessionMaterialId('session-a', OWNER_MATERIAL_B),
      ),
    ).toBe(false);
    expect([...objects.keys()]).toEqual([ossKey]);
  });

  it('creates no metadata when the snapshot byte write fails', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    const { ossKey } = await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    const failingStore: MaterialByteStore = {
      ...byteStore,
      put: vi.fn().mockRejectedValue(new Error('snapshot write failed')),
    };

    await expect(
      bindOwnerMaterialsToSession('session-a', 'owner-a', [OWNER_MATERIAL_A], {
        ...bindDependencies(),
        byteStore: failingStore,
      }),
    ).rejects.toBeInstanceOf(SessionMaterialBindingError);
    expect(await materials.listMaterials('session-a')).toEqual([]);
    expect([...objects.keys()]).toEqual([ossKey]);
  });

  it('keeps tombstoned metadata for retry when byte cleanup fails', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    const [bound] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    const row = await materials.getMaterial('session-a', bound!.materialId);
    const deleteBytes = vi
      .fn<(key: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup unavailable'))
      .mockImplementation(byteStore.delete.bind(byteStore));
    const failingStore = { ...byteStore, delete: deleteBytes };

    await expect(
      deleteOwnedSessionWithMaterials('session-a', 'owner-a', {
        ...cleanupDependencies(),
        byteStore: failingStore,
      }),
    ).rejects.toThrow('cleanup unavailable');
    expect(await materials.getMaterial('session-a', bound!.materialId)).toBeNull();
    expect(
      await materials.getDeletedSessionMaterialsForCleanup('session-a', 'owner-a'),
    ).toHaveLength(1);
    expect(objects.has(row!.rawAssetId!)).toBe(true);

    await expect(
      cleanupDeletedSessionMaterials('session-a', 'owner-a', {
        ...cleanupDependencies(),
        byteStore: failingStore,
      }),
    ).resolves.toBe(true);
    expect(deleteBytes).toHaveBeenCalledTimes(2);
    expect(await materials.getDeletedSessionMaterialsForCleanup('session-a', 'owner-a')).toEqual(
      [],
    );
  });

  it('retains tombstoned session metadata when its final purge fails', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await insertOwnerMaterial('owner-a', OWNER_MATERIAL_A);
    const [bound] = await bindOwnerMaterialsToSession(
      'session-a',
      'owner-a',
      [OWNER_MATERIAL_A],
      bindDependencies(),
    );
    const row = await materials.getMaterial('session-a', bound!.materialId);
    const purge = vi
      .fn<(sessionId: string, ownerId: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('session metadata purge failed'))
      .mockImplementation(materials.purgeDeletedSessionMaterials.bind(materials));
    const materialStore = {
      getDeletedSessionMaterialsForCleanup:
        materials.getDeletedSessionMaterialsForCleanup.bind(materials),
      purgeDeletedSessionMaterials: purge,
    };

    await expect(
      deleteOwnedSessionWithMaterials('session-a', 'owner-a', {
        ...cleanupDependencies(),
        materialStore,
      }),
    ).rejects.toThrow('session metadata purge failed');
    expect(objects.has(row!.rawAssetId!)).toBe(false);
    expect(
      await materials.getDeletedSessionMaterialsForCleanup('session-a', 'owner-a'),
    ).toHaveLength(1);

    await expect(
      cleanupDeletedSessionMaterials('session-a', 'owner-a', {
        ...cleanupDependencies(),
        materialStore,
      }),
    ).resolves.toBe(true);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('refuses cleanup of foreign-key metadata and leaves its pointer for repair', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    await materials.createMaterial('session-a', {
      id: 'mat_corrupt',
      kind: 'source',
      rawAssetId: 'materials/v1/sessions/ses_foreign/mat_foreign/raw.bin',
    });
    await sessions.softDeleteSession('session-a', 'owner-a');

    await expect(
      cleanupDeletedSessionMaterials('session-a', 'owner-a', cleanupDependencies()),
    ).rejects.toThrow('foreign object key');
    expect(
      await materials.getDeletedSessionMaterialsForCleanup('session-a', 'owner-a'),
    ).toHaveLength(1);
  });

  it('refuses cleanup when a recorded key hides traversal behind the session prefix', async () => {
    await sessions.createSession({ id: 'session-a', ownerId: 'owner-a', prompt: 'a' });
    const traversal = `${sessionMaterialObjectPrefix('session-a')}../session-b/private.bin`;
    await materials.createMaterial('session-a', {
      id: 'mat_corrupt',
      kind: 'source',
      rawAssetId: traversal,
    });
    await sessions.softDeleteSession('session-a', 'owner-a');

    await expect(
      cleanupDeletedSessionMaterials('session-a', 'owner-a', cleanupDependencies()),
    ).rejects.toThrow('foreign object key');
    expect(
      await materials.getDeletedSessionMaterialsForCleanup('session-a', 'owner-a'),
    ).toHaveLength(1);
  });
});

function deferredSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('durable session material write claims', () => {
  const sessionId = 'session-claim-race';
  const ownerId = 'owner-claim-race';
  let db: PGlite;
  let sessions: PgAgentSessionStore;
  let materials: PgAgentSessionMaterialStore;
  let root: string;
  let byteStore: LocalMaterialByteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    materials = new PgAgentSessionMaterialStore(db, {
      withTransaction: (body) => db.transaction((tx: Queryable) => body(tx)),
    });
    root = await mkdtemp(join(tmpdir(), 'openmaic-material-claims-'));
    byteStore = new LocalMaterialByteStore(root);
    await sessions.createSession({ id: sessionId, ownerId, prompt: 'claim race' });
  });

  afterEach(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
  });

  const cleanupDependencies = () => ({
    byteStore,
    sessionStore: sessions,
    materialStore: materials,
  });

  async function expectObjectMissing(key: string): Promise<void> {
    await expect(byteStore.get(key)).rejects.toMatchObject({ code: 'ENOENT' });
  }

  it('T1 retains a pre-delete claim after a late publish crash and repeated cleanup recovers it', async () => {
    const materialId = 'mat_claim_crash';
    const objectKey = sessionMaterialObjectKey(sessionId, materialId, 'raw.bin');
    const claim = await materials.claimMaterialWrite(sessionId, {
      materialId,
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey,
    });
    const published = deferredSignal();
    const crash = deferredSignal();
    const writer = materials.executeClaimedMaterialWrite(claim.id, async () => {
      await byteStore.put(objectKey, Buffer.from('published-before-crash'));
      published.resolve();
      await crash.promise;
      throw new Error('simulated writer crash');
    });
    await published.promise;

    const interruptedCleanup: MaterialByteStore = {
      put: byteStore.put.bind(byteStore),
      get: byteStore.get.bind(byteStore),
      delete: vi.fn().mockRejectedValue(new Error('cleanup interrupted')),
      deletePrefix: byteStore.deletePrefix.bind(byteStore),
    };
    let deletionSettled = false;
    const deletion = deleteOwnedSessionWithMaterials(sessionId, ownerId, {
      ...cleanupDependencies(),
      byteStore: interruptedCleanup,
    }).finally(() => {
      deletionSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);

    crash.resolve();
    await expect(writer).rejects.toThrow('simulated writer crash');
    await expect(deletion).rejects.toThrow('cleanup interrupted');
    await expect(byteStore.get(objectKey)).resolves.toEqual(Buffer.from('published-before-crash'));
    await expect(
      materials.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, ownerId),
    ).resolves.toEqual([expect.objectContaining({ id: claim.id, state: 'claimed', objectKey })]);

    await expect(
      cleanupDeletedSessionMaterials(sessionId, ownerId, cleanupDependencies()),
    ).resolves.toBe(true);
    await expectObjectMissing(objectKey);
    await expect(
      materials.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, ownerId),
    ).resolves.toEqual([]);
  });

  it('T2 refuses finalize after tombstone and cannot resurrect a matching material row', async () => {
    const materialId = 'mat_staged_before_delete';
    const objectKey = sessionMaterialObjectKey(sessionId, materialId, 'raw.bin');
    const claim = await materials.claimMaterialWrite(sessionId, {
      materialId,
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey,
    });
    await expect(
      materials.executeClaimedMaterialWrite(claim.id, () =>
        byteStore.put(objectKey, Buffer.from('staged')),
      ),
    ).resolves.toBe(true);
    await materials.createMaterial(sessionId, {
      id: materialId,
      kind: 'source',
      rawAssetId: objectKey,
    });
    await expect(sessions.softDeleteSession(sessionId, ownerId)).resolves.toBe(true);

    await expect(
      finalizeSessionMaterialObjectWrite(
        { sessionId, materialId, objectKey, claimId: claim.id },
        { byteStore, materialStore: materials },
      ),
    ).resolves.toBe(false);
    expect(await sessions.getSession(sessionId)).toBeNull();
    expect(await materials.getMaterial(sessionId, materialId)).toBeNull();
    await expectObjectMissing(objectKey);
    await expect(
      materials.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, ownerId),
    ).resolves.toEqual([]);

    await expect(
      cleanupDeletedSessionMaterials(sessionId, ownerId, cleanupDependencies()),
    ).resolves.toBe(true);
  });

  it('T3 rejects a new production writer after deletion before byte-store put', async () => {
    await expect(
      deleteOwnedSessionWithMaterials(sessionId, ownerId, cleanupDependencies()),
    ).resolves.toBe(true);
    const put = vi.spyOn(byteStore, 'put');

    await expect(
      storeSessionMaterialRawAsset(
        sessionId,
        'mat_after_delete',
        'source',
        Buffer.from('must-not-publish'),
        'application/octet-stream',
        { dependencies: { byteStore, materialStore: materials } },
      ),
    ).rejects.toMatchObject({ code: 'session_missing' });
    expect(put).not.toHaveBeenCalled();
    expect(await sessions.getSession(sessionId)).toBeNull();
  });

  it('T4 cleans two concurrent claims when one writer crashes and deletion drains the other', async () => {
    const crashedKey = sessionMaterialObjectKey(sessionId, 'mat_writer_crash', 'raw.bin');
    const stagedKey = sessionMaterialObjectKey(sessionId, 'mat_writer_staged', 'raw.bin');
    const crashedClaim = await materials.claimMaterialWrite(sessionId, {
      materialId: 'mat_writer_crash',
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey: crashedKey,
    });
    const stagedClaim = await materials.claimMaterialWrite(sessionId, {
      materialId: 'mat_writer_staged',
      materialKind: 'source',
      objectSlot: 'raw',
      objectKey: stagedKey,
    });
    const crashedPublished = deferredSignal();
    const releaseCrashedWriter = deferredSignal();
    const crashedWriter = materials.executeClaimedMaterialWrite(crashedClaim.id, async () => {
      await byteStore.put(crashedKey, Buffer.from('crash'));
      crashedPublished.resolve();
      await releaseCrashedWriter.promise;
      throw new Error('writer one crashed');
    });
    await crashedPublished.promise;
    const stagedPublished = deferredSignal();
    const releaseStagedWriter = deferredSignal();
    const stagedWriter = materials.executeClaimedMaterialWrite(stagedClaim.id, async () => {
      await byteStore.put(stagedKey, Buffer.from('staged'));
      stagedPublished.resolve();
      await releaseStagedWriter.promise;
    });
    // Queue writer two behind writer one's session lock before delete requests
    // the same tombstone fence. Both operations are now in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    let deletionSettled = false;
    const deletion = deleteOwnedSessionWithMaterials(
      sessionId,
      ownerId,
      cleanupDependencies(),
    ).finally(() => {
      deletionSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deletionSettled).toBe(false);

    releaseCrashedWriter.resolve();
    await expect(crashedWriter).rejects.toThrow('writer one crashed');
    await stagedPublished.promise;
    expect(deletionSettled).toBe(false);
    releaseStagedWriter.resolve();
    await expect(stagedWriter).resolves.toBe(true);
    await expect(deletion).resolves.toBe(true);
    await expectObjectMissing(crashedKey);
    await expectObjectMissing(stagedKey);
    await expect(
      materials.getDeletedSessionMaterialWriteClaimsForCleanup(sessionId, ownerId),
    ).resolves.toEqual([]);
    await expect(
      materials.getDeletedSessionMaterialsForCleanup(sessionId, ownerId),
    ).resolves.toEqual([]);
  });
});
