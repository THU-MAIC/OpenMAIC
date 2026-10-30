/**
 * Owner-level extraction on PGlite. The same scenarios run on PostgreSQL in
 * the `.pg` suite, which adds the cases that need parallel connections.
 */
import { randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, it, vi } from 'vitest';

import {
  bootExtractionHarness,
  failureReasonScenario,
  failedImageDownloadScenario,
  cancelledImageDownloadScenario,
  documentFallbackScenario,
  documentServiceUnavailableScenario,
  tooManyPagesScenario,
  cacheCollectorOrderScenario,
  claimIntoSameContentScenario,
  sameKeyConcurrentSourcesScenario,
  claimBudgetScenario,
  deletedSourceScenario,
  ensureStartedScenario,
  fallbackReuseScenario,
  parserFailureScenario,
  heartbeatLossScenario,
  lostClaimStopsProvidersScenario,
  lostDuringLookupScenario,
  mediaDerivativeScenario,
  ownerCacheScenario,
  ownerClaimMidRunScenario,
  publishRollbackScenario,
  quotaFailureScenario,
  resultLimitScenario,
  sameBytesOtherMimeScenario,
  schemaCompatibilityScenario,
  supersededClaimScenario,
  twoConversationsOneExtractionScenario,
  uploadQueuesExtractionScenario,
  withdrawnDonorScenario,
  type ExtractionHarness,
  type ExtractionScenarioPool,
} from './_owner-extraction-scenarios';

/**
 * A pool over PGlite's single session.
 *
 * Every "connection" is that one session, so two transactions run at once
 * would interleave their statements in one transaction block: the first
 * COMMIT ends it for both, and the other's remaining statements run outside
 * any transaction (a SAVEPOINT there is an error). A real pool gives each
 * transaction a session of its own. This pool approximates that by giving a
 * transaction the session exclusively from its BEGIN to its COMMIT or
 * ROLLBACK: any other statement waits until the transaction ends.
 */
class PGlitePool implements ExtractionScenarioPool {
  private owner: object | null = null;
  private released: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  constructor(readonly db: PGlite) {}

  private async run<TRow>(client: object, text: string, params?: unknown[]) {
    while (this.owner !== null && this.owner !== client) await this.released;
    const statement = text.trim().toUpperCase();
    if (statement.startsWith('BEGIN')) {
      this.owner = client;
      this.released = new Promise<void>((resolve) => (this.release = resolve));
    }
    try {
      return (await this.db.query(text, params)) as { rows: TRow[] };
    } finally {
      if (
        this.owner === client &&
        (statement.startsWith('COMMIT') || statement.startsWith('ROLLBACK')) &&
        !statement.startsWith('ROLLBACK TO')
      ) {
        this.owner = null;
        this.release();
      }
    }
  }

  async query<TRow>(text: string, params?: unknown[]) {
    return this.run<TRow>(this, text, params);
  }

  async connect() {
    const client = {};
    return {
      query: (text: string, params?: unknown[]) => this.run(client, text, params),
      release() {},
    };
  }

  async end() {}
}

describe('owner-level material extraction (PGlite)', () => {
  let db: PGlite | undefined;

  async function boot(env: Record<string, string> = {}): Promise<ExtractionHarness> {
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `postgres://owner-extraction-${randomUUID()}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    db = new PGlite();
    await db.waitReady;
    return bootExtractionHarness(new PGlitePool(db), databaseUrl);
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db?.close();
    db = undefined;
  });

  it('starts idle and failed sources once and leaves pending, running and done ones alone', async () => {
    await ensureStartedScenario(await boot());
  });

  it('queues an upload in the transaction that publishes it', async () => {
    await uploadQueuesExtractionScenario(await boot());
  });

  it('extracts a source two conversations start exactly once', async () => {
    await twoConversationsOneExtractionScenario(await boot());
  });

  it('says the parsing service is unavailable only when no document candidate is configured', async () => {
    await documentServiceUnavailableScenario(await boot());
  });

  it('keeps document fallback, and a PDF’s own failure, free of that reason', async () => {
    await documentFallbackScenario(await boot());
  });

  it('ends a PDF refused for too many pages at the refusal, with its counts', async () => {
    await tooManyPagesScenario(await boot());
  });

  it('keeps public failure reasons on current terminal claims only', async () => {
    await failureReasonScenario(await boot());
  });

  it('spends the claim budget on takeovers and keeps a heartbeating lease', async () => {
    await claimBudgetScenario(await boot());
  });

  it('refuses every write of a superseded claim, across a manual restart too', async () => {
    await supersededClaimScenario(await boot());
  });

  it('never claims a deleted source and refuses a claim of one', async () => {
    await deletedSourceScenario(await boot());
  });

  it('publishes once for the account when the owner is claimed mid-run', async () => {
    await ownerClaimMidRunScenario(await boot());
  });

  it('rolls a failed publication back completely', async () => {
    await publishRollbackScenario(await boot());
  });

  it('reuses an owner s earlier result only when it still holds', async () => {
    await ownerCacheScenario(await boot());
  });

  it('stores media derivatives as owner materials of their own', async () => {
    await mediaDerivativeScenario(await boot());
  });

  it('fails a source whose outputs do not fit the asset quota, publishing nothing', async () => {
    await quotaFailureScenario(await boot({ ASSET_QUOTA_BYTES: '1000' }));
  });

  it('fails a result over the configured size cap and publishes one that fits', async () => {
    await resultLimitScenario(await boot({ OPENMAIC_MATERIAL_EXTRACTION_MAX_RESULT_MB: '1' }));
  });

  it('keeps the bootstrap rerunnable and the public view unchanged', async () => {
    await schemaCompatibilityScenario(await boot());
  });

  it('stops a run whose heartbeat finds the claim taken over before it allocates', async () => {
    await heartbeatLossScenario(await boot());
  });

  it('keeps a reused result through the donor s deletion and refuses a hit the collector took', async () => {
    await cacheCollectorOrderScenario(await boot());
  });

  it('lets two sources of the same bytes extract and publish their own results at once', async () => {
    await sameKeyConcurrentSourcesScenario(await boot());
  });

  it('keeps both results when a claim brings the same content into an account that has it', async () => {
    await claimIntoSameContentScenario(await boot());
  });

  it('stops provider fallback on a parse failure and spends only the existing retry budget', async () => {
    await parserFailureScenario(await boot());
  });

  it('reuses a document fallback s earlier result when the provider ahead of it fails', async () => {
    await fallbackReuseScenario(await boot());
  });

  it('never reuses a result whose image downloads failed', async () => {
    await failedImageDownloadScenario(await boot());
  });

  it('stops a run cancelled while an image download stalls, settling nothing', async () => {
    await cancelledImageDownloadScenario(await boot());
  });

  it('does not reuse a done donor that no longer roots its result', async () => {
    await withdrawnDonorScenario(await boot());
  });

  it('extracts the same bytes uploaded as video and as audio apart, in both orders', async () => {
    await sameBytesOtherMimeScenario(await boot());
  });

  it('calls no further provider once the claim is found lost', async () => {
    await lostClaimStopsProvidersScenario(await boot());
  });

  it('calls no provider when the claim is lost while the cache lookup waits', async () => {
    await lostDuringLookupScenario(await boot());
  });
});
