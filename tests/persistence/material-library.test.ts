/**
 * Phase 2 of the material library on PGlite. The same scenarios run on
 * PostgreSQL in the `.pg` suite, which adds the races that need parallel
 * connections.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, it, vi } from 'vitest';

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
  type LibraryHarness,
  type ExtractionScenarioPool,
} from './_material-library-scenarios';

class PGlitePool implements ExtractionScenarioPool {
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

// Real databases, real extraction and real pools: generous under a loaded machine.
describe('material library (PGlite)', { timeout: 20_000 }, () => {
  let db: PGlite | undefined;

  async function boot(env: Record<string, string> = {}): Promise<LibraryHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `postgres://material-library-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootLibraryHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
  });

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
