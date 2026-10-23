/**
 * The material root wrapper (`lib/persistence/material-roots.ts`): one root
 * call per transaction, only inside it, and only ever under the owner's own
 * asset partition.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { AssetRootTargetError } from '@openmaic/storage/asset/pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every input the wrapper hands the storage root API, so a test can check the
// principals exactly rather than only that one wrong partition is refused.
const rootCalls = vi.hoisted(() => [] as Array<{ principals: readonly string[] }>);
vi.mock('@openmaic/storage/asset/pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openmaic/storage/asset/pg')>();
  return {
    ...actual,
    changeAssetRoots: (...args: Parameters<typeof actual.changeAssetRoots>) => {
      rootCalls.push({ principals: [...args[1].principals] });
      return actual.changeAssetRoots(...args);
    },
  };
});

import {
  MaterialRootCallError,
  withMaterialRoots,
  type MaterialRootScope,
} from '@/lib/persistence/material-roots';
import {
  LEGACY_SHARED_ASSET_PRINCIPAL,
  assetPrincipalForOwner,
} from '@/lib/persistence/owner-assets';
import {
  getServerPersistenceProvider,
  type ServerPersistenceProvider,
} from '@/lib/persistence/server-provider';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

const OWNER = 'user:alice';
const OTHER = 'user:carol';

describe('withMaterialRoots', () => {
  let db: PGlite;
  let provider: ServerPersistenceProvider;

  beforeEach(async () => {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    const databaseUrl = `postgres://material-roots-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    rootCalls.length = 0;
    db = new PGlite();
    await db.waitReady;
    provider = await getServerPersistenceProvider(databaseUrl, () => new PGlitePool(db) as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  const allocate = (principalKey: string, text: string): Promise<string> =>
    provider.assetStore.put({ key: principalKey }, new Blob([text]));
  const rootsOf = async (id: string): Promise<string[]> =>
    (
      await db.query<{ root_id: string }>(
        'SELECT root_id FROM asset_root_refs WHERE asset_id = $1 ORDER BY root_id',
        [id],
      )
    ).rows.map((row) => row.root_id);
  const run = <T>(body: (scope: MaterialRootScope) => Promise<T>): Promise<T> =>
    withMaterialRoots(
      provider,
      { ownerId: OWNER, fence: 'request', materialIds: ['mat-1', 'mat-2'] },
      body,
    );

  it('roots the owner’s own entry under the material id', async () => {
    const id = await allocate(assetPrincipalForOwner(OWNER).key, 'own');

    await run(({ changeRoots }) => changeRoots({ add: [{ materialId: 'mat-1', assetIds: [id] }] }));

    expect(await rootsOf(id)).toEqual(['mat-1']);
    // Exactly the owner's own partition: nothing else, the shared one included.
    expect(rootCalls).toEqual([{ principals: [assetPrincipalForOwner(OWNER).key] }]);
  });

  it('rolls back a root call still running when a concurrent second call fails the body', async () => {
    const id = await allocate(assetPrincipalForOwner(OWNER).key, 'concurrent');

    // The second call is refused at once while the first is still queued on
    // the transaction's connection; the body fails before the first finishes.
    await expect(
      run(({ changeRoots }) =>
        Promise.all([
          changeRoots({ add: [{ materialId: 'mat-1', assetIds: [id] }] }),
          changeRoots({ add: [{ materialId: 'mat-2', assetIds: [id] }] }),
        ]),
      ),
    ).rejects.toBeInstanceOf(MaterialRootCallError);

    expect(await rootsOf(id)).toEqual([]);
    const lifecycle = await db.query<{ committed_at: unknown }>(
      'SELECT committed_at FROM asset_entries WHERE id = $1',
      [id],
    );
    expect(lifecycle.rows[0]?.committed_at).toBeNull();
  });

  it('fails the transaction, without an unhandled rejection, when an unawaited root call fails early', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const foreign = await allocate(assetPrincipalForOwner(OTHER).key, 'refused early');
      await expect(
        run(async ({ changeRoots }) => {
          // Neither awaited nor caught by the caller, and the body goes on
          // waiting for something else after the root call has failed.
          void changeRoots({ add: [{ materialId: 'mat-1', assetIds: [foreign] }] });
          await new Promise((resolve) => setTimeout(resolve, 100));
        }),
      ).rejects.toBeInstanceOf(AssetRootTargetError);
      // Give a would-be unhandled rejection the turn it needs to be reported.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(await rootsOf(foreign)).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('waits for a root call the body did not await, and fails with it', async () => {
    const own = await allocate(assetPrincipalForOwner(OWNER).key, 'not awaited');
    await run(async ({ changeRoots }) => {
      void changeRoots({ add: [{ materialId: 'mat-1', assetIds: [own] }] });
    });
    expect(await rootsOf(own)).toEqual(['mat-1']);

    const foreign = await allocate(assetPrincipalForOwner(OTHER).key, 'refused, not awaited');
    await expect(
      run(async ({ changeRoots }) => {
        void changeRoots({ add: [{ materialId: 'mat-2', assetIds: [foreign] }] }).catch(
          () => undefined,
        );
      }),
    ).rejects.toBeInstanceOf(AssetRootTargetError);
  });

  it('refuses a second root call and rolls the first one back with it', async () => {
    const id = await allocate(assetPrincipalForOwner(OWNER).key, 'twice');

    await expect(
      run(async ({ changeRoots }) => {
        await changeRoots({ add: [{ materialId: 'mat-1', assetIds: [id] }] });
        await changeRoots({ add: [{ materialId: 'mat-2', assetIds: [id] }] });
      }),
    ).rejects.toBeInstanceOf(MaterialRootCallError);

    expect(await rootsOf(id)).toEqual([]);
  });

  it('refuses a root call once its transaction has ended', async () => {
    const id = await allocate(assetPrincipalForOwner(OWNER).key, 'late');
    let escaped: MaterialRootScope | undefined;
    await run(async (scope) => {
      escaped = scope;
    });

    await expect(
      escaped!.changeRoots({ add: [{ materialId: 'mat-1', assetIds: [id] }] }),
    ).rejects.toBeInstanceOf(MaterialRootCallError);
    expect(await rootsOf(id)).toEqual([]);
  });

  it('never roots an entry of the legacy shared partition', async () => {
    // Were the shared partition among the principals, this would succeed:
    // the entry exists and the shared partition holds it.
    const shared = await allocate(LEGACY_SHARED_ASSET_PRINCIPAL, 'shared');

    await expect(
      run(({ changeRoots }) => changeRoots({ add: [{ materialId: 'mat-1', assetIds: [shared] }] })),
    ).rejects.toBeInstanceOf(AssetRootTargetError);
    expect(await rootsOf(shared)).toEqual([]);
  });

  it('never roots another owner’s entry', async () => {
    const foreign = await allocate(assetPrincipalForOwner(OTHER).key, 'foreign');

    await expect(
      run(({ changeRoots }) =>
        changeRoots({ add: [{ materialId: 'mat-1', assetIds: [foreign] }] }),
      ),
    ).rejects.toBeInstanceOf(AssetRootTargetError);
    expect(await rootsOf(foreign)).toEqual([]);
  });

  it('rolls the root back when the body fails after it', async () => {
    const id = await allocate(assetPrincipalForOwner(OWNER).key, 'rolled back');

    await expect(
      run(async ({ changeRoots }) => {
        await changeRoots({ add: [{ materialId: 'mat-1', assetIds: [id] }] });
        throw new Error('later statement failed');
      }),
    ).rejects.toThrow('later statement failed');

    expect(await rootsOf(id)).toEqual([]);
    const lifecycle = await db.query<{ committed_at: unknown; expires_at: unknown }>(
      'SELECT committed_at, expires_at FROM asset_entries WHERE id = $1',
      [id],
    );
    // Still a pending allocation: the root's commit of the entry rolled back too.
    expect(lifecycle.rows[0]?.committed_at).toBeNull();
    expect(lifecycle.rows[0]?.expires_at).not.toBeNull();
  });
});
