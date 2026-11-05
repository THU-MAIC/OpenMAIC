/** Local PostgreSQL acceptance. No paid cloud calls. PG_CONTRACT_URL=<isolated-test-database> */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { AssetByteStore } from '@openmaic/storage/asset/pg';
import { S3AssetByteStore } from '@openmaic/storage/asset/s3-bytes';
import type { ServerPersistenceProvider } from '@/lib/persistence/server-provider';
vi.mock('server-only', () => ({}));
import { CheckpointStorage } from '@/lib/server/sandbox/checkpoint-storage';
import { SandboxService } from '@/lib/server/sandbox/service';
import { SandboxStore, type SandboxRow } from '@/lib/server/sandbox/store';
import { ensureSandboxEnvironmentSchema } from '@/lib/persistence/sandbox-environments';
import { ensureOwnerMergeSchema } from '@/lib/persistence/owner-merges';
const contractUrl = process.env.PG_CONTRACT_URL;
const schema = 'sandbox_check_' + randomUUID().replaceAll('-', '');
let admin: Pool, pool: Pool, storage: CheckpointStorage, store: SandboxStore, row: SandboxRow;
let persistence: ServerPersistenceProvider;
const objects = new Map<string, Uint8Array>();
let failWrite = false,
  failDelete = false;
const commands = {
  put: (x: unknown) => ({ type: 'put', ...(x as object) }),
  get: (x: unknown) => ({ type: 'get', ...(x as object) }),
  delete: (x: unknown) => ({ type: 'delete', ...(x as object) }),
};
const client = {
  send: async (cmd: unknown) => {
    const c = cmd as { type: string; Key: string; Body: Uint8Array };
    if (c.type === 'put') {
      if (failWrite) throw Error('PUT failed');
      objects.set(c.Key, Uint8Array.from(c.Body));
      return {};
    }
    if (c.type === 'delete') {
      if (failDelete) throw Error('DELETE failed');
      objects.delete(c.Key);
      return {};
    }
    const b = objects.get(c.Key);
    if (!b) throw Object.assign(Error('missing'), { name: 'NoSuchKey' });
    return { Body: { transformToByteArray: async () => b } };
  },
};
const base = new S3AssetByteStore({ bucket: 'test-bucket', client, commands });
const source = async function* (text = 'checkpoint content') {
  yield Buffer.from(text);
};
async function save(row: SandboxRow, revision: number, source: AsyncIterable<Uint8Array>) {
  return store.exclusive(row.id, () => storage.saveLocked(row, revision, source));
}
async function bytes(saved: Awaited<ReturnType<CheckpointStorage['get']>>) {
  const chunks = [];
  for await (const c of storage.read(row.owner_id, saved!)) chunks.push(c);
  return Buffer.concat(chunks).toString();
}
describe.skipIf(!contractUrl)('isolated checkpoint metadata and collection', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.PG_CONTRACT_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: process.env.PG_CONTRACT_URL,
      options: `-c search_path=${schema}`,
    });
    await ensureOwnerMergeSchema(pool);
    await ensureSandboxEnvironmentSchema(pool);
    persistence = {
      pool,
      withTransaction: async (fn: (tx: import('pg').PoolClient) => Promise<unknown>) => {
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          const r = await fn(tx);
          await tx.query('COMMIT');
          return r;
        } catch (e) {
          await tx.query('ROLLBACK');
          throw e;
        } finally {
          tx.release();
        }
      },
    } as unknown as ServerPersistenceProvider;
    store = Reflect.construct(SandboxStore, [persistence]) as SandboxStore;
    storage = new CheckpointStorage(persistence, store.exclusive.bind(store), async () => base);
    row = (
      await store.reserve({
        ownerId: 'owner-a',
        id: randomUUID(),
        workspaceId: 'test-project',
        fingerprint: 'test',
        maxActive: 5,
        maxActiveTotal: 5,
        profile: 'code',
      })
    ).row;
    objects.set('sha256-course-fixture', Buffer.from('course asset'));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('stores only metadata in PG and streams verified bytes under its own prefix', async () => {
    const saved = await save(row, 0, source());
    expect(saved.revision).toBe(1);
    const checkpoint = await storage.get(row.owner_id, row.workspace_id);
    expect(checkpoint).not.toHaveProperty('archive_bytes');
    expect(checkpoint?.object_id).toBeTruthy();
    expect(await bytes(checkpoint)).toBe('checkpoint content');
    expect([...objects.keys()].filter((x) => x.startsWith('sandbox-checkpoints/v1/'))).toHaveLength(
      1,
    );
    expect(await storage.get('foreign', row.workspace_id)).toBeNull();
    await expect(
      (async () => {
        for await (const c of storage.read('foreign', checkpoint!)) void c;
      })(),
    ).rejects.toThrow('metadata');
  });
  it('retains the previous head on PUT failure and records uncertain uploads for collection', async () => {
    failWrite = true;
    await expect(save(row, 1, source('uncommitted'))).rejects.toThrow();
    failWrite = false;
    expect((await storage.get(row.owner_id, row.workspace_id))?.revision).toBe(1);
    const rows = (
      await pool.query("SELECT parts_json FROM sandbox_checkpoint_objects WHERE state='pending'")
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].parts_json).toHaveLength(1);
  });
  it('enforces CAS and retires older versions after durable replacement', async () => {
    await save(row, 1, source('new version'));
    expect((await storage.get(row.owner_id, row.workspace_id))?.revision).toBe(2);
    await expect(save(row, 1, source())).rejects.toThrow('newer');
    expect(
      (await pool.query("SELECT id FROM sandbox_checkpoint_objects WHERE state='retired'")).rows,
    ).toHaveLength(1);
  });
  it('preserves metadata after failed collection and never touches the current version or course bytes', async () => {
    await pool.query(
      "UPDATE sandbox_checkpoint_objects SET updated_at=now()-interval '25 hours' WHERE state<>'committed'",
    );
    failDelete = true;
    expect((await storage.collect()).deferred).toBe(2);
    failDelete = false;
    expect((await storage.collect()).collected).toBe(2);
    expect(await bytes(await storage.get(row.owner_id, row.workspace_id))).toBe('new version');
    expect(Buffer.from(objects.get('sha256-course-fixture')!).toString()).toBe('course asset');
    // A course-store deletion addresses its bare hash, never the checkpoint namespace.
    const saved = await storage.get(row.owner_id, row.workspace_id);
    const part = (
      await pool.query('SELECT parts_json FROM sandbox_checkpoint_objects WHERE id=$1', [
        saved!.object_id,
      ])
    ).rows[0].parts_json[0];
    await base.delete(part.hash);
    expect(await bytes(saved)).toBe('new version');
  });
  it('does not collect an in-flight old upload held by another worker', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO sandbox_checkpoint_objects(id,owner_id,workspace_id,object_prefix,policy_json,state,updated_at,source_environment_id)
      VALUES($1,'owner-a','test-project',$2,'{}','pending',now()-interval '25 hours',$3)`,
      [id, 'sandbox-checkpoints/v1/' + id + '/', row.id],
    );
    await store.exclusive(row.id, async () => {
      expect((await storage.collect()).deferred).toBe(1);
    });
    expect((await storage.collect()).collected).toBe(1);
  });
  it('rejects corruption, changed root policy, and owner quota before committing', async () => {
    const saved = await storage.get(row.owner_id, row.workspace_id);
    const key = [...objects.keys()].find((x) => x.startsWith('sandbox-checkpoints/'))!;
    const original = objects.get(key)!;
    objects.set(key, Buffer.from('corrupt'));
    await expect(bytes(saved)).rejects.toThrow('checksum');
    objects.set(key, original);
    vi.stubEnv(
      'OPENMAIC_SANDBOX_CHECKPOINT_PATHS',
      '[{"name":"app","path":"/home/user/.config/app","excludes":[]}]',
    );
    await expect(bytes(saved)).rejects.toThrow('paths changed');
    vi.unstubAllEnvs();
    vi.stubEnv('OPENMAIC_SANDBOX_CHECKPOINT_OWNER_BYTES', '1024');
    await expect(save(row, 2, source('x'.repeat(2048)))).rejects.toThrow('quota');
    vi.unstubAllEnvs();
    expect((await storage.get(row.owner_id, row.workspace_id))?.revision).toBe(2);
  });
  it('explicit deletion retires bytes, and a disabled external backend refuses saving', async () => {
    await store.transition(row, ['creating'], 'destroyed');
    await store.deleteCheckpoint(row.owner_id, row.workspace_id, 2);
    expect(await storage.get(row.owner_id, row.workspace_id)).toBeNull();
    await pool.query("UPDATE sandbox_checkpoint_objects SET updated_at=now()-interval '25 hours'");
    await storage.collect();
    expect([...objects.keys()]).toEqual(['sha256-course-fixture']);
    const unavailable = new CheckpointStorage(
      { pool } as ServerPersistenceProvider,
      store.exclusive.bind(store),
      async () => ({ write: vi.fn(), read: vi.fn(), delete: vi.fn() }) as AssetByteStore,
    );
    expect(await unavailable.available()).toBe(false);
    await expect(unavailable.saveLocked(row, 0, source())).rejects.toThrow('external');
  });
  it("recovers an absent owner's expired capacity without touching unknown reservations", async () => {
    const expiredId = randomUUID();
    const config = { fingerprint: 'test', maxActive: 1, maxActivePerOwner: 1, lifetimeMs: 300000 };
    const reservation = {
      ownerId: 'owner-expired',
      id: expiredId,
      workspaceId: 'expired',
      fingerprint: 'test',
      maxActive: 1,
      maxActiveTotal: 1,
      profile: 'code' as const,
    };
    const expired = (await store.reserve(reservation)).row;
    expect(await store.reconciliationCandidates('test')).toEqual([]);
    await store.transition(expired, ['creating'], 'running', 'expired-cloud');
    expect(await store.reconciliationCandidates('foreign-config')).toEqual([]);
    const provider = {
      initializeWorkspace: vi.fn().mockResolvedValue(undefined),
      renew: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'new-cloud', state: 'running' }),
    };
    const service = Reflect.construct(SandboxService, [
      'owner-new',
      config,
      store,
      provider,
    ]) as SandboxService;
    const newId = randomUUID();
    expect((await service.create(newId, 'new-project')).state).toBe('running');
    expect((await store.get('owner-expired', expiredId)).state).toBe('destroyed');
    expect(provider.inspect).toHaveBeenCalledWith('expired-cloud', expiredId);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(provider.renew).toHaveBeenCalledWith('new-cloud', newId, 300000, undefined);
    await store.transition(await store.get('owner-new', newId), ['running'], 'destroyed');
    const unknown = (await store.reserve({ ...reservation, id: randomUUID() })).row;
    await store.transition(unknown, ['creating'], 'unknown');
    expect(await store.reconciliationCandidates('test')).toEqual([]);
    await expect(service.create(randomUUID(), 'blocked')).rejects.toMatchObject({
      code: 'SANDBOX_LIMIT',
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after a stalled upload aborts and never commits its late result', async () => {
    const target = (
      await store.reserve({
        ownerId: 'timeout-owner',
        id: randomUUID(),
        workspaceId: 'timeout',
        fingerprint: 'test',
        maxActive: 100,
        maxActiveTotal: 100,
        profile: 'code',
      })
    ).row;
    await store.exclusive(target.id, () => storage.saveLocked(target, 0, source('durable')));
    let finish!: () => void;
    let observed: AbortSignal | undefined;
    const stalled = new CheckpointStorage(persistence, store.exclusive.bind(store), async () => ({
      writesOutsideRegistryDatabase: true,
      write: async () => {},
      read: async () => null,
      delete: async () => {},
      withPrefix: () => ({
        write: async (_hash, _bytes, options) => {
          observed = options?.signal;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        read: async () => null,
        delete: async () => {},
      }),
    }));
    const controller = new AbortController();
    const saving = store.exclusive(target.id, () =>
      stalled.saveLocked(target, 1, source('late'), controller.signal),
    );
    const rejected = expect(saving).rejects.toThrow('deadline');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort(new DOMException('deadline', 'TimeoutError'));
    await rejected;
    expect(observed?.aborted).toBe(true);
    expect((await storage.get(target.owner_id, target.workspace_id))?.revision).toBe(1);
    await store.exclusive(target.id, () => storage.saveLocked(target, 1, source('new durable')));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect((await storage.get(target.owner_id, target.workspace_id))?.revision).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT id FROM sandbox_checkpoint_objects WHERE source_environment_id=$1 AND state='pending'",
          [target.id],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('publishes a prepared head and its consumer metadata in one transaction', async () => {
    const target = (
      await store.reserve({
        ownerId: 'atomic-owner',
        id: randomUUID(),
        workspaceId: 'atomic',
        fingerprint: 'test',
        maxActive: 100,
        maxActiveTotal: 100,
        profile: 'code',
      })
    ).row;
    await store.exclusive(target.id, () => storage.saveLocked(target, 0, source('durable')));
    const pending = await storage.prepare(target, 1, source('unpublished'));
    await expect(
      pending.commit(async (tx) => {
        await tx.query('UPDATE sandbox_environments SET preview_epoch=1 WHERE id=$1', [target.id]);
        throw new Error('consumer metadata failed');
      }),
    ).rejects.toThrow('consumer metadata failed');
    expect((await storage.get(target.owner_id, target.workspace_id))?.revision).toBe(1);
    expect((await store.get(target.owner_id, target.id)).preview_epoch).toBe(0);
    await pending.discard();
  });
});
