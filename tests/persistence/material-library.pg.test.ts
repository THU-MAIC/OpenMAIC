/**
 * Phase 2 of the material library on a real PostgreSQL, where transactions
 * run on separate connections: the shared scenarios, and the races only
 * parallel connections can show.
 *
 * Each test works in a schema of its own (see
 * `document-asset-references.pg.test.ts` for why), dropped afterwards.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { NextRequest } from 'next/server';
import { PATCH as renameRoute } from '@/app/api/materials/[id]/route';
import { POST as createFolderRoute } from '@/app/api/materials/folders/route';

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(() => 'user:alice'),
);
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claimOwner, resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import * as documentImages from '@/lib/server/material-extraction/document-images';
import { readOwnerMaterialText } from '@/lib/server/materials/owner-material-text';
import {
  createMaterialFolder,
  renameMaterialFolder,
  deleteMaterialFolder,
  moveMaterials,
  deleteMaterial,
} from '@/lib/persistence/material-library';
import {
  claimNextOwnerMaterialExtraction,
  ensureOwnerMaterialExtraction,
} from '@/lib/persistence/owner-material-extraction';
import {
  runClaimedOwnerExtraction,
  runNextOwnerExtraction,
} from '@/lib/server/material-extraction/owner-extraction';

import { ACCOUNT, ANON, seedDerivative } from './_material-library-scenarios';
import { ensure, seedSource, stateOf } from './_owner-extraction-scenarios';
import {
  deleteLegacyScenario,
  deleteChainScenario,
  deleteSharedScenario,
  deleteRefusalScenario,
  deleteRollbackScenario,
  deleteExtractionScenario,
  deleteReadsScenario,
  watcherRetryScenario,
  watcherNullExtractionScenario,
  watcherStaleWaitScenario,
  attachByIdScenario,
  attachRefusalScenario,
  bootLibraryHarness,
  foldersScenario,
  folderCountsScenario,
  moveScenario,
  renameMaterialScenario,
  deleteFolderScenario,
  organizeAcrossClaimScenario,
  copyOnUseScenario,
  deletedThroughLinkScenario,
  documentImagesQuotaScenario,
  documentImagesScenario,
  documentImageBudgetScenario,
  existingCopyScenario,
  libraryListingScenario,
  listingDerivedFieldsScenario,
  libraryReachScenario,
  libraryToolFlowScenario,
  legacyCopyLibraryToolsScenario,
  sessionListingPaginationScenario,
  ownerListingWithSessionCopyScenario,
  linkAcrossClaimScenario,
  mediaLibraryScopeScenario,
  ownerRunnerScenario,
  rawConsumersScenario,
  releaseEdgesScenario,
  releaseRefusedOutputsScenario,
  resolverScenario,
  textAcrossClaimScenario,
  type ExtractionHarness,
  type LibraryHarness,
} from './_material-library-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;
/** Longer than any lock wait these races should see; a deadlock or a hang fails it. */
const RACE_BUDGET_MS = 15_000;

let serial = 0;

// Real databases, real extraction and real pools: generous under a loaded machine.
describe.skipIf(!contractUrl)('material library on PostgreSQL', { timeout: 20_000 }, () => {
  let admin: Pool | undefined;
  const pools: Pool[] = [];
  let schema: string;

  async function boot(env: Record<string, string> = {}): Promise<LibraryHarness> {
    serial += 1;
    schema = `openmaic_material_library_test_${serial}`;
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      application_name: `material-library-${serial}`,
      max: 8,
    });
    pools.push(pool);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=material-library-${serial}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    return bootLibraryHarness(pool as never, databaseUrl);
  }

  /**
   * `withTransaction` whose transactions pause before the first statement
   * matching `pattern`, run `before()`, then go on: how a race is put in a
   * fixed order without a hook in the code under test.
   */
  function pausingBefore(
    h: ExtractionHarness,
    pattern: RegExp,
    before: (tx: { query(text: string, params?: unknown[]): Promise<unknown> }) => Promise<void>,
  ): { withTransaction: ExtractionHarness['provider']['withTransaction'] } {
    type Tx = { query(text: string, params?: unknown[]): Promise<unknown> };
    let fired = false;
    const pausing = (tx: Tx): Tx => ({
      query: async (text, params) => {
        if (!fired && pattern.test(text)) {
          fired = true;
          await before(tx);
        }
        return tx.query(text, params);
      },
    });
    const withTransaction = (body: (tx: Tx) => Promise<unknown>) =>
      (
        h.provider.withTransaction as unknown as (
          run: (tx: Tx) => Promise<unknown>,
        ) => Promise<unknown>
      )((tx) => body(pausing(tx)));
    return { withTransaction: withTransaction as never };
  }

  /** As {@link pausingBefore}, but runs `after()` once the matching statement has answered. */
  function pausingAfter(
    h: ExtractionHarness,
    pattern: RegExp,
    after: (tx: { query(text: string, params?: unknown[]): Promise<unknown> }) => Promise<void>,
  ): { withTransaction: ExtractionHarness['provider']['withTransaction'] } {
    type Tx = { query(text: string, params?: unknown[]): Promise<unknown> };
    let fired = false;
    const pausing = (tx: Tx): Tx => ({
      query: async (text, params) => {
        const answer = await tx.query(text, params);
        if (!fired && pattern.test(text)) {
          fired = true;
          await after(tx);
        }
        return answer;
      },
    });
    const withTransaction = (body: (tx: Tx) => Promise<unknown>) =>
      (
        h.provider.withTransaction as unknown as (
          run: (tx: Tx) => Promise<unknown>,
        ) => Promise<unknown>
      )((tx) => body(pausing(tx)));
    return { withTransaction: withTransaction as never };
  }

  /** Wait until some connection of this test's schema waits on a lock. */
  async function untilSomeoneWaits(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const waiting = await admin!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM pg_stat_activity
          WHERE application_name = $1 AND wait_event_type = 'Lock'`,
        [`material-library-${serial}`],
      );
      if (Number(waiting.rows[0]!.count) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('nobody queued behind the lock');
  }

  async function withinBudget<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('race did not settle in time')), RACE_BUDGET_MS),
      ),
    ]);
  }

  /** A video source queued and claimed, whose run publishes a keyframe derivative. */
  async function claimedVideo(h: ExtractionHarness, id: string) {
    await seedSource(h, id, { mime: 'video/mp4', bytes: Buffer.from(`mp4-${id}`) });
    await ensureOwnerMaterialExtraction(h.provider.withTransaction, ACCOUNT, id);
    return (await claimNextOwnerMaterialExtraction(h.pool as never, {
      leaseTtlMs: 60_000,
      now: h.clock.now,
      createToken: () => `token-${id}`,
    }))!;
  }

  async function newFolder(h: ExtractionHarness, name: string): Promise<string> {
    const made = await createMaterialFolder(h.provider, {
      ownerId: ACCOUNT,
      name,
      fence: 'request',
    });
    if (made.status !== 'ok') throw new Error('expected a folder');
    return made.folder.id;
  }

  /**
   * Start a waiter and verify that its exact backend waits on this holder.
   * The waiter's backend is read just before its first `lockStatement`.
   */
  async function waitingOn(
    h: ExtractionHarness,
    holderTx: { query(text: string, params?: unknown[]): Promise<unknown> },
    run: (provider: ExtractionHarness['provider']) => Promise<unknown>,
    lockStatement: RegExp = /^SELECT id FROM owner_material WHERE id = ANY/,
  ): Promise<Promise<unknown>[]> {
    const holder = (
      (await holderTx.query('SELECT pg_backend_pid() AS pid')) as { rows: { pid: number }[] }
    ).rows[0]!.pid;
    let observed!: (pid: number) => void;
    const waiterPid = new Promise<number>((resolve) => {
      observed = resolve;
    });
    const waiter = pausingBefore(h, lockStatement, async (tx) => {
      observed(
        ((await tx.query('SELECT pg_backend_pid() AS pid')) as { rows: { pid: number }[] }).rows[0]!
          .pid,
      );
    });
    const pending = run({ ...h.provider, ...waiter });
    // Observe rejection immediately, while retaining it for the assertion.
    pending.catch(() => undefined);
    const pid = await withinBudget(waiterPid);
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const found = await admin!.query<{ blocked: boolean }>(
        'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
        [pid, holder],
      );
      if (found.rows[0]?.blocked) return [pending];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the deletion race waiter never queued behind its holder');
  }

  describe('source deletion races', () => {
    it('releases the identity fence before a legacy parse waits, so an owner claim completes', async () => {
      const h = await boot();
      await seedSource(h, 'text-outside-fence', { owner: ANON });
      await ensure(h, 'text-outside-fence', ANON);
      await runNextOwnerExtraction(h.deps());
      const result = (await stateOf(h, 'text-outside-fence')).extraction_result!;
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      const paused = new Promise<void>((r) => (release = r));
      const parsing = vi
        .spyOn(documentImages, 'resolveDerivativeRefsAsync')
        .mockImplementation(async () => {
          entered();
          await paused;
          return '# Lesson';
        });
      const reading = readOwnerMaterialText({
        id: 'text-outside-fence',
        ownerId: ANON,
        extractionResult: { ...result, text: { ...result.text, assetId: randomUUID() } },
      });
      let claiming: ReturnType<typeof claimOwner> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await reached;
        claiming = claimOwner(ANON, ACCOUNT, { provider: h.provider });
        const outcome = await Promise.race([
          claiming,
          new Promise<{ status: string }>((r) => {
            timeout = setTimeout(() => r({ status: 'blocked' }), 2_000);
          }),
        ]);
        expect(outcome).toMatchObject({ status: 'claimed' });
      } finally {
        if (timeout) clearTimeout(timeout);
        release();
        await Promise.allSettled([reading, claiming]);
        parsing.mockRestore();
      }
      expect(await reading).toEqual({ text: '# Lesson', revision: result.revision });
    });

    it('deletes derivatives committed by a publisher it waited for', async () => {
      const h = await boot();
      const claim = await claimedVideo(h, 'delete-publish-first');
      let deletion: Promise<unknown> | undefined;
      const publishing = pausingBefore(h, /^\s*INSERT INTO owner_material/, async (tx) => {
        [deletion] = await waitingOn(h, tx, (provider) =>
          deleteMaterial(provider, {
            ownerId: ACCOUNT,
            materialId: claim.materialId,
            fence: 'request',
          }),
        );
      });
      expect(
        await withinBudget(
          runClaimedOwnerExtraction(
            claim,
            h.deps({ persistence: { ...h.provider, ...publishing } }),
          ),
        ),
      ).toBe('published');
      expect(await withinBudget(deletion!)).toMatchObject({ status: 'deleted' });
      const derivative = (await stateOf(h, claim.materialId)).extraction_result!.derivatives[0]!;
      expect(
        (await h.pool.query('SELECT deleted_at FROM owner_material WHERE id = $1', [derivative.id]))
          .rows[0],
      ).not.toEqual({ deleted_at: null });
      expect(
        await h.pool.query('SELECT * FROM asset_root_refs WHERE root_id = ANY($1::text[])', [
          [claim.materialId, derivative.id],
        ]),
      ).toMatchObject({ rows: [] });
    });

    it('refuses a publisher waiting behind deletion and releases its outputs', async () => {
      const h = await boot();
      const claim = await claimedVideo(h, 'delete-first');
      let publication: Promise<unknown> | undefined;
      const deleting = pausingBefore(h, /^UPDATE owner_material SET deleted_at/, async (tx) => {
        [publication] = await waitingOn(h, tx, (provider) =>
          runClaimedOwnerExtraction(claim, h.deps({ persistence: provider })),
        );
      });
      expect(
        await withinBudget(
          deleteMaterial(
            { ...h.provider, ...deleting },
            { ownerId: ACCOUNT, materialId: claim.materialId, fence: 'request' },
          ),
        ),
      ).toMatchObject({ status: 'deleted' });
      expect(await withinBudget(publication!)).toBe('not-authorized');
      expect(
        (
          await h.pool.query(
            'SELECT * FROM owner_material WHERE derived_from = $1 AND deleted_at IS NULL',
            [claim.materialId],
          )
        ).rows,
      ).toEqual([]);
      expect((await h.pool.query('SELECT * FROM asset_root_refs')).rows).toEqual([]);
      expect((await h.pool.query('SELECT * FROM asset_entries')).rows).toEqual([]);
    });

    it.each(['reuse', 'delete'] as const)(
      'keeps cache reuse safe when %s holds the donor first',
      async (first) => {
        const h = await boot();
        const donor = await claimedVideo(h, 'delete-cache-donor');
        expect(await runClaimedOwnerExtraction(donor, h.deps())).toBe('published');
        await seedSource(h, 'delete-cache-recipient', {
          mime: 'video/mp4',
          bytes: h.sources.get(donor.materialId),
        });
        await ensureOwnerMaterialExtraction(
          h.provider.withTransaction,
          ACCOUNT,
          'delete-cache-recipient',
        );
        const recipient = (await claimNextOwnerMaterialExtraction(h.pool as never, {
          leaseTtlMs: 60_000,
          now: h.clock.now,
          createToken: randomUUID,
        }))!;
        let second: Promise<unknown> | undefined;
        if (first === 'reuse') {
          const reusing = pausingBefore(h, /^\s*INSERT INTO owner_material/, async (tx) => {
            [second] = await waitingOn(h, tx, (provider) =>
              deleteMaterial(provider, {
                ownerId: ACCOUNT,
                materialId: donor.materialId,
                fence: 'request',
              }),
            );
          });
          expect(
            await withinBudget(
              runClaimedOwnerExtraction(
                recipient,
                h.deps({ persistence: { ...h.provider, ...reusing } }),
              ),
            ),
          ).toBe('reused');
          expect(await withinBudget(second!)).toMatchObject({ status: 'deleted' });
          expect((await stateOf(h, recipient.materialId)).extraction_result!.reusedFrom).toBe(
            donor.materialId,
          );
          expect(h.mediaExtract).toHaveBeenCalledTimes(1);
        } else {
          const deleting = pausingBefore(h, /^UPDATE owner_material SET deleted_at/, async (tx) => {
            [second] = await waitingOn(h, tx, (provider) =>
              runClaimedOwnerExtraction(recipient, h.deps({ persistence: provider })),
            );
          });
          expect(
            await withinBudget(
              deleteMaterial(
                { ...h.provider, ...deleting },
                { ownerId: ACCOUNT, materialId: donor.materialId, fence: 'request' },
              ),
            ),
          ).toMatchObject({ status: 'deleted' });
          expect(await withinBudget(second!)).toBe('published');
          expect(
            (await stateOf(h, recipient.materialId)).extraction_result!.reusedFrom,
          ).toBeUndefined();
          expect(h.mediaExtract).toHaveBeenCalledTimes(2);
        }
        const donorResult = (await stateOf(h, donor.materialId)).extraction_result!;
        for (const id of [donor.materialId, ...donorResult.derivatives.map((d) => d.id)]) {
          expect(
            (await h.pool.query('SELECT * FROM asset_root_refs WHERE root_id = $1', [id])).rows,
          ).toEqual([]);
        }
        const result = (await stateOf(h, recipient.materialId)).extraction_result!;
        for (const id of [result.text.assetId, ...result.derivatives.map((d) => d.assetId)]) {
          expect(
            await h.provider.assetStore.resolve({ key: `owner:${ACCOUNT}` }, id),
          ).not.toBeNull();
        }
      },
    );

    describe('and a move naming a derivative before its source', () => {
      // 'mixed-d' sorts before 'mixed-s'. A move that locked every id named
      // would hold the derivative while waiting for the source, which a
      // deletion holds while it waits for the derivative.
      const moveLock = /^\s*SELECT id, owner_id, derived_from, status, deleted_at, folder_id/;
      const move = (provider: ExtractionHarness['provider'], folderId: string) =>
        moveMaterials(provider, {
          ownerId: ACCOUNT,
          materialIds: ['mixed-d', 'mixed-s'],
          folderId,
          fence: 'request',
        });
      async function mixed(h: ExtractionHarness) {
        await seedSource(h, 'mixed-s');
        await seedDerivative(h, 'mixed-d', 'mixed-s');
        return newFolder(h, 'Target');
      }
      async function expectDeleted(h: ExtractionHarness) {
        expect(
          (
            await h.pool.query(
              `SELECT id, folder_id, deleted_at IS NOT NULL AS deleted FROM owner_material
                WHERE id IN ('mixed-d', 'mixed-s') ORDER BY id`,
            )
          ).rows,
        ).toEqual([
          { id: 'mixed-d', folder_id: null, deleted: true },
          { id: 'mixed-s', folder_id: null, deleted: true },
        ]);
      }

      it('waits for a deletion holding the source, then refuses both', async () => {
        const h = await boot();
        const folder = await mixed(h);
        let moving: Promise<unknown> | undefined;
        // Paused holding the source only, before it locks the derivative.
        const deleting = pausingBefore(
          h,
          /^SELECT id FROM owner_material WHERE derived_from/,
          async (tx) => {
            [moving] = await waitingOn(h, tx, (provider) => move(provider, folder), moveLock);
          },
        );
        expect(
          await withinBudget(
            deleteMaterial(
              { ...h.provider, ...deleting },
              { ownerId: ACCOUNT, materialId: 'mixed-s', fence: 'request' },
            ),
          ),
        ).toEqual({ status: 'deleted', materialIds: ['mixed-s', 'mixed-d'] });
        expect(await withinBudget(moving!)).toEqual({
          status: 'not_movable',
          materialIds: ['mixed-d', 'mixed-s'],
        });
        await expectDeleted(h);
      });

      it('makes a deletion wait for the move holding the source, which refuses', async () => {
        const h = await boot();
        const folder = await mixed(h);
        let deletion: Promise<unknown> | undefined;
        const moving = pausingAfter(h, moveLock, async (tx) => {
          [deletion] = await waitingOn(h, tx, (provider) =>
            deleteMaterial(provider, {
              ownerId: ACCOUNT,
              materialId: 'mixed-s',
              fence: 'request',
            }),
          );
        });
        expect(await withinBudget(move({ ...h.provider, ...moving }, folder))).toEqual({
          status: 'not_movable',
          materialIds: ['mixed-d'],
        });
        expect(await withinBudget(deletion!)).toEqual({
          status: 'deleted',
          materialIds: ['mixed-s', 'mixed-d'],
        });
        await expectDeleted(h);
      });
    });

    it('serializes concurrent deletions into deleted and not_found', async () => {
      const h = await boot();
      await seedSource(h, 'delete-twice');
      let second: Promise<unknown> | undefined;
      const deleting = pausingBefore(h, /^UPDATE owner_material SET deleted_at/, async (tx) => {
        [second] = await waitingOn(h, tx, (provider) =>
          deleteMaterial(provider, {
            ownerId: ACCOUNT,
            materialId: 'delete-twice',
            fence: 'request',
          }),
        );
      });
      expect(
        await withinBudget(
          deleteMaterial(
            { ...h.provider, ...deleting },
            { ownerId: ACCOUNT, materialId: 'delete-twice', fence: 'request' },
          ),
        ),
      ).toEqual({ status: 'deleted', materialIds: ['delete-twice'] });
      expect(await withinBudget(second!)).toEqual({ status: 'not_found' });
    });
  });
  describe('races', () => {
    it('a move holding the source makes a publication waiting on it file its derivative in the new folder', async () => {
      const h = await boot();
      const target = await newFolder(h, 'Unit 1');
      const claim = await claimedVideo(h, 'vid-a');
      let publication: Promise<unknown> | undefined;
      const move = pausingBefore(h, /^\s*UPDATE owner_material SET folder_id/, async () => {
        publication = runClaimedOwnerExtraction(claim, h.deps());
        await untilSomeoneWaits();
      });
      expect(
        await withinBudget(
          moveMaterials(move, {
            ownerId: ACCOUNT,
            materialIds: ['vid-a'],
            folderId: target,
            fence: 'request',
          }),
        ),
      ).toMatchObject({ status: 'moved' });
      expect(await withinBudget(publication!)).toBe('published');
      const [derivative] = (await stateOf(h, 'vid-a')).extraction_result!.derivatives;
      expect((await stateOf(h, derivative!.id)).folder_id).toBe(target);
    });

    it('a move waiting on a publication that holds the source moves the derivative it published', async () => {
      const h = await boot();
      const target = await newFolder(h, 'Unit 1');
      const claim = await claimedVideo(h, 'vid-a');
      let move: Promise<unknown> | undefined;
      const publishing = pausingBefore(h, /^\s*INSERT INTO owner_material/, async () => {
        move = moveMaterials(h.provider, {
          ownerId: ACCOUNT,
          materialIds: ['vid-a'],
          folderId: target,
          fence: 'request',
        });
        await untilSomeoneWaits();
      });
      expect(
        await withinBudget(
          runClaimedOwnerExtraction(
            claim,
            h.deps({ persistence: { ...h.provider, ...publishing } as never }),
          ),
        ),
      ).toBe('published');
      expect(await withinBudget(move!)).toMatchObject({ status: 'moved' });
      const [derivative] = (await stateOf(h, 'vid-a')).extraction_result!.derivatives;
      expect((await stateOf(h, derivative!.id)).folder_id).toBe(target);
      expect((await stateOf(h, 'vid-a')).folder_id).toBe(target);
    });

    it('a folder deleted first refuses a move into it that waited', async () => {
      const h = await boot();
      const folder = await newFolder(h, 'Empty');
      await seedSource(h, 'src-a');
      let move: Promise<unknown> | undefined;
      const deleting = pausingBefore(h, /^\s*DELETE FROM material_folders/, async () => {
        move = moveMaterials(h.provider, {
          ownerId: ACCOUNT,
          materialIds: ['src-a'],
          folderId: folder,
          fence: 'request',
        });
        await untilSomeoneWaits();
      });
      expect(
        await withinBudget(
          deleteMaterialFolder(deleting, {
            ownerId: ACCOUNT,
            folderId: folder,
            fence: 'request',
          }),
        ),
      ).toEqual({ status: 'deleted' });
      expect(await withinBudget(move!)).toEqual({ status: 'folder_not_found' });
      expect((await stateOf(h, 'src-a')).folder_id).toBeNull();
    });

    it.each(['publication', 'deletion'] as const)(
      'preserves extraction derivatives when %s holds its lock first during folder deletion',
      async (first) => {
        const h = await boot();
        const folder = await newFolder(h, 'Parsing');
        const claim = await claimedVideo(h, 'folder-publish-race');
        await moveMaterials(h.provider, {
          ownerId: ACCOUNT,
          materialIds: [claim.materialId],
          folderId: folder,
          fence: 'request',
        });
        let second: Promise<unknown> | undefined;
        if (first === 'publication') {
          const publishing = pausingBefore(h, /^\s*INSERT INTO owner_material/, async () => {
            second = deleteMaterialFolder(h.provider, {
              ownerId: ACCOUNT,
              folderId: folder,
              fence: 'request',
            });
            await untilSomeoneWaits();
          });
          expect(
            await withinBudget(
              runClaimedOwnerExtraction(
                claim,
                h.deps({ persistence: { ...h.provider, ...publishing } }),
              ),
            ),
          ).toBe('published');
          expect(await withinBudget(second!)).toEqual({ status: 'deleted' });
        } else {
          const deleting = pausingBefore(h, /^\s*UPDATE owner_material SET folder_id/, async () => {
            second = runClaimedOwnerExtraction(claim, h.deps());
            await untilSomeoneWaits();
          });
          expect(
            await withinBudget(
              deleteMaterialFolder(deleting, {
                ownerId: ACCOUNT,
                folderId: folder,
                fence: 'request',
              }),
            ),
          ).toEqual({ status: 'deleted' });
          expect(await withinBudget(second!)).toBe('published');
        }
        const result = (await stateOf(h, claim.materialId)).extraction_result!;
        expect(result.derivatives.length).toBeGreaterThan(0);
        const ids = [claim.materialId, ...result.derivatives.map((d) => d.id)];
        const rows = await h.pool.query(
          'SELECT folder_id, deleted_at FROM owner_material WHERE id = ANY($1::text[])',
          [ids],
        );
        expect(rows.rows).toHaveLength(ids.length);
        for (const row of rows.rows) expect(row).toEqual({ folder_id: null, deleted_at: null });
        expect(
          (
            await h.pool.query('SELECT * FROM asset_root_refs WHERE root_id = ANY($1::text[])', [
              ids,
            ])
          ).rows.length,
        ).toBeGreaterThan(0);
      },
    );

    it('a move into a folder first is included by the deletion that waited', async () => {
      const h = await boot();
      const folder = await newFolder(h, 'Soon full');
      await seedSource(h, 'src-a');
      await seedDerivative(h, 'img-a1', 'src-a');
      let deletion: Promise<unknown> | undefined;
      const moving = pausingBefore(h, /^\s*UPDATE owner_material SET folder_id/, async () => {
        deletion = deleteMaterialFolder(h.provider, {
          ownerId: ACCOUNT,
          folderId: folder,
          fence: 'request',
        });
        await untilSomeoneWaits();
      });
      expect(
        await withinBudget(
          moveMaterials(moving, {
            ownerId: ACCOUNT,
            materialIds: ['src-a'],
            folderId: folder,
            fence: 'request',
          }),
        ),
      ).toMatchObject({ status: 'moved' });
      expect(await withinBudget(deletion!)).toEqual({ status: 'deleted' });
      expect((await stateOf(h, 'img-a1')).folder_id).toBeNull();
      expect((await stateOf(h, 'src-a')).folder_id).toBeNull();
    });
  });

  afterEach(async () => {
    resetClaimParticipantsForTests();
    vi.unstubAllEnvs();
    for (const pool of pools.splice(0)) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      admin = undefined;
    }
  });

  it.each(['source row', 'folder creation'] as const)(
    'answers 503 and rolls back when the %s lock times out after the owner fence',
    async (kind) => {
      const h = await boot({ OPENMAIC_AGENT_RUNTIME_ENABLED: 'true' });
      await seedSource(h, 'locked-source');
      // Shorten the wait only for the request under test. The identity lock is
      // an advisory lock shared by the whole database, and other PG suites
      // running in parallel take the same owner's; seeding under 250 ms could
      // time out on them instead of on the lock this test holds.
      vi.stubEnv('OWNER_WRITE_LOCK_WAIT_MS', '250');
      const sourceName = async () =>
        (await h.pool.query("SELECT display_name FROM owner_material WHERE id = 'locked-source'"))
          .rows[0];
      const original = await sourceName();
      const holder = await (h.pool as unknown as Pool).connect();
      try {
        await holder.query('BEGIN');
        if (kind === 'source row') {
          await holder.query("SELECT id FROM owner_material WHERE id = 'locked-source' FOR UPDATE");
        } else {
          await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `material-folders:${ACCOUNT}:create`,
          ]);
        }
        const req = new NextRequest(
          'http://localhost/api/materials/' + (kind === 'source row' ? 'locked-source' : 'folders'),
          {
            method: kind === 'source row' ? 'PATCH' : 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Must roll back' }),
          },
        );
        const pending =
          kind === 'source row'
            ? renameRoute(req, { params: Promise.resolve({ id: 'locked-source' }) })
            : createFolderRoute(req);
        await untilSomeoneWaits();
        const response = await withinBudget(pending);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('2');
        expect(await response.json()).toMatchObject({ error: { code: 'OWNER_BUSY' } });
        expect(await sourceName()).toEqual(original);
        expect(
          (await h.pool.query("SELECT id FROM material_folders WHERE name = 'Must roll back'"))
            .rows,
        ).toEqual([]);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    },
  );

  it('keeps watching a retry when an older failed poll returns', async () => {
    await watcherRetryScenario(await boot());
  });
  it('does not settle a NULL extraction, but settles tombstones and missing sources', async () => {
    await watcherNullExtractionScenario(await boot());
  });
  it('reports once when a wait returns a stale running snapshot', async () => {
    await watcherStaleWaitScenario(await boot());
  });

  describe('links', () => {
    it('attaches by id without a copy and reaches the source and its derivatives', async () => {
      await attachByIdScenario(await boot());
    });

    it('keeps reading a copy the session already holds', async () => {
      await existingCopyScenario(await boot());
    });

    it('attaches only the owner’s ready, undeleted sources, all or nothing', async () => {
      await attachRefusalScenario(await boot());
    });

    it('answers nothing through the link of a deleted source', async () => {
      await deletedThroughLinkScenario(await boot());
    });

    it('reaches unattached materials in library scope, never another owner’s', async () => {
      await libraryReachScenario(await boot());
    });

    it('keeps a link valid across a claim', async () => {
      await linkAcrossClaimScenario(await boot());
    });

    it('lists the library by folder, Unfiled and literal query, in pages', async () => {
      await libraryListingScenario(await boot());
    });

    it('derives lineage, attachment and searchable sources beyond the rows listed', async () => {
      await listingDerivedFieldsScenario(await boot());
    });
  });

  describe('resolver', () => {
    it('resolves session rows and owner materials, and reads each one’s bytes and text', async () => {
      await resolverScenario(await boot());
    });

    it('reads a source’s text across a claim, with the revision it found', async () => {
      await textAcrossClaimScenario(await boot());
    });

    it('reads original bytes for every consumer, whatever kind of row, and says when they are unavailable', async () => {
      await rawConsumersScenario(await boot());
    });
  });

  describe('extraction', () => {
    it.each(['bytes', 'tags'] as const)(
      'publishes and reads an over-%s-budget document with reachable images',
      async (budget) => {
        await documentImageBudgetScenario(await boot(), budget);
      },
    );

    it('keeps a document’s images as derivatives and names them in its text', async () => {
      await documentImagesScenario(await boot());
    });

    it('publishes nothing when a document’s images do not fit the quota', async () => {
      await documentImagesQuotaScenario(await boot({ ASSET_QUOTA_BYTES: '2000' }));
    });

    it('removes the outputs of a run refused for certain, and keeps them when unsure', async () => {
      await releaseRefusedOutputsScenario(await boot());
    });

    it('keeps a committed publication, releases after a root refusal, and only warns when a release fails', async () => {
      await releaseEdgesScenario(await boot());
    });

    it('runs queued extractions and waits for a run under way when stopped', async () => {
      await ownerRunnerScenario(await boot());
    });
  });

  describe('organizing', () => {
    it('reuses a folder when create races with a rename to the same name', async () => {
      const h = await boot();
      const initial = await createMaterialFolder(h.provider, {
        ownerId: ACCOUNT,
        name: 'Old',
        fence: 'request',
      });
      if (initial.status !== 'ok') throw new Error('folder setup failed');
      let releaseRename!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        releaseRename = resolve;
      });
      let markRenamed!: () => void;
      const renamedInTransaction = new Promise<void>((resolve) => {
        markRenamed = resolve;
      });
      const renamed = renameMaterialFolder(
        {
          withTransaction: (body) =>
            h.provider.withTransaction(async (tx) => {
              const outcome = await body(tx);
              markRenamed();
              await mayCommit;
              return outcome;
            }),
        },
        { ownerId: ACCOUNT, folderId: initial.folder.id, name: 'Unit 1', fence: 'request' },
      );
      let created: ReturnType<typeof createMaterialFolder> | undefined;
      try {
        await withinBudget(renamedInTransaction);
        created = createMaterialFolder(h.provider, {
          ownerId: ACCOUNT,
          name: 'Unit 1',
          fence: 'request',
        });
        await untilSomeoneWaits();
        releaseRename();
        expect(await withinBudget(renamed)).toMatchObject({ status: 'renamed' });
        expect(await withinBudget(created)).toMatchObject({
          status: 'ok',
          created: false,
          folder: { id: initial.folder.id, name: 'Unit 1' },
        });
      } finally {
        releaseRename();
        await Promise.allSettled([renamed, created]);
      }
    });

    it('creates, lists and renames folders, within the per-owner limit', async () => {
      await foldersScenario(await boot());
    });

    it('counts live ready sources in all existing-folder answers', async () => {
      await folderCountsScenario(await boot());
    });

    it('moves sources with their derivatives, all or nothing', async () => {
      await moveScenario(await boot());
    });

    it('renames a source, never a derivative', async () => {
      await renameMaterialScenario(await boot());
    });

    it('deletes a non-empty folder without deleting files, and rolls back a failed deletion', async () => {
      await deleteFolderScenario(await boot());
    });

    it('refuses a retired owner’s request and follows a claim for a run', async () => {
      await organizeAcrossClaimScenario(await boot());
    });
  });

  describe('courses', () => {
    it('copies a material into a course as an entry of its own', async () => {
      await copyOnUseScenario(await boot());
    });

    it('uses an unattached material in library scope without attaching it', async () => {
      await mediaLibraryScopeScenario(await boot());
    });
  });

  describe('tools', () => {
    it('keeps session-copy precedence out of the owner page listing', async () => {
      await ownerListingWithSessionCopyScenario(await boot());
    });
    it('pages all legacy sources before document derivatives using real storage', async () => {
      await sessionListingPaginationScenario(await boot());
    });
    it('keeps library search, listing and follow-up reads consistent with legacy-copy precedence', async () => {
      await legacyCopyLibraryToolsScenario(await boot());
    });
    it('extracts, waits for, reads and searches a library source by its own id', async () => {
      await libraryToolFlowScenario(await boot());
    });
  });
  describe('source deletion', () => {
    it('cleans legacy originals only after commit and retries without migration', async () => {
      await deleteLegacyScenario(await boot());
    });
    it('deletes the complete published chain and releases both quotas', async () => {
      await deleteChainScenario(await boot());
    });
    it('retains cache recipients and donors in both directions', async () => {
      await deleteSharedScenario(await boot());
    });
    it('refuses derivatives, inaccessible sources and retired owners', async () => {
      await deleteRefusalScenario(await boot());
    });
    it('rolls deletion back when withdrawing roots fails', async () => {
      await deleteRollbackScenario(await boot());
    });
    it('cancels pending and running extraction through tombstones', async () => {
      await deleteExtractionScenario(await boot());
    });
    it('hides deleted sources from reads and listings, retaining old copies', async () => {
      await deleteReadsScenario(await boot());
    });
  });
});
