/**
 * Phase 2 of the material library on PGlite. The same scenarios run on
 * PostgreSQL in the `.pg` suite, which adds the races that need parallel
 * connections.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, it, vi } from 'vitest';

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
