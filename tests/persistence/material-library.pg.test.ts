/**
 * Phase 2 of the material library on a real PostgreSQL, where transactions
 * run on separate connections: the shared scenarios, and the races only
 * parallel connections can show.
 *
 * Each test works in a schema of its own (see
 * `document-asset-references.pg.test.ts` for why), dropped afterwards.
 */
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetClaimParticipantsForTests } from '@/lib/persistence/owner-claims';
import {
  createMaterialFolder,
  renameMaterialFolder,
  deleteEmptyMaterialFolder,
  moveMaterials,
} from '@/lib/persistence/material-library';
import {
  claimNextOwnerMaterialExtraction,
  ensureOwnerMaterialExtraction,
} from '@/lib/persistence/owner-material-extraction';
import { runClaimedOwnerExtraction } from '@/lib/server/material-extraction/owner-extraction';

import { ACCOUNT, seedDerivative } from './_material-library-scenarios';
import { seedSource, stateOf } from './_owner-extraction-scenarios';
import {
  attachByIdScenario,
  attachRefusalScenario,
  bootLibraryHarness,
  foldersScenario,
  moveScenario,
  renameMaterialScenario,
  deleteFolderScenario,
  organizeAcrossClaimScenario,
  copyOnUseScenario,
  deletedThroughLinkScenario,
  documentImagesQuotaScenario,
  documentImagesScenario,
  existingCopyScenario,
  libraryListingScenario,
  listingDerivedFieldsScenario,
  libraryReachScenario,
  libraryToolFlowScenario,
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
    before: () => Promise<void>,
  ): { withTransaction: ExtractionHarness['provider']['withTransaction'] } {
    type Tx = { query(text: string, params?: unknown[]): Promise<unknown> };
    let fired = false;
    const pausing = (tx: Tx): Tx => ({
      query: async (text, params) => {
        if (!fired && pattern.test(text)) {
          fired = true;
          await before();
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
          deleteEmptyMaterialFolder(deleting, {
            ownerId: ACCOUNT,
            folderId: folder,
            fence: 'request',
          }),
        ),
      ).toEqual({ status: 'deleted' });
      expect(await withinBudget(move!)).toEqual({ status: 'folder_not_found' });
      expect((await stateOf(h, 'src-a')).folder_id).toBeNull();
    });

    it('a move into a folder first makes a deletion that waited find it not empty', async () => {
      const h = await boot();
      const folder = await newFolder(h, 'Soon full');
      await seedSource(h, 'src-a');
      await seedDerivative(h, 'img-a1', 'src-a');
      let deletion: Promise<unknown> | undefined;
      const moving = pausingBefore(h, /^\s*UPDATE owner_material SET folder_id/, async () => {
        deletion = deleteEmptyMaterialFolder(h.provider, {
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
      expect(await withinBudget(deletion!)).toEqual({ status: 'not_empty', materialCount: 2 });
      expect((await stateOf(h, 'img-a1')).folder_id).toBe(folder);
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

    it('moves sources with their derivatives, all or nothing', async () => {
      await moveScenario(await boot());
    });

    it('renames a source, never a derivative', async () => {
      await renameMaterialScenario(await boot());
    });

    it('deletes only an empty folder, tombstones aside', async () => {
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
    it('extracts, waits for, reads and searches a library source by its own id', async () => {
      await libraryToolFlowScenario(await boot());
    });
  });
});
