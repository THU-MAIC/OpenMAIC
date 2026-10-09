/**
 * Owner-level extraction on a real PostgreSQL, where transactions run on
 * separate connections: the shared scenarios, and the races only parallel
 * connections can show -- two workers claiming at once, a publication
 * waiting for a claim of its owner, and a superseded publication racing the
 * current one. Every race must settle within a bounded time with exactly one
 * outcome.
 *
 * Each test works in a schema of its own (see
 * `document-asset-references.pg.test.ts` for why), dropped afterwards.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerClaimParticipant,
  claimOwner,
  resetClaimParticipantsForTests,
} from '@/lib/persistence/owner-claims';
import { publishOwnerMaterialExtraction } from '@/lib/persistence/owner-material-extraction';
import { runClaimedOwnerExtraction } from '@/lib/server/material-extraction/owner-extraction';

import {
  ACCOUNT,
  ANON,
  bootExtractionHarness,
  failureReasonScenario,
  documentFallbackScenario,
  documentServiceUnavailableScenario,
  cacheCollectorOrderScenario,
  claimIntoSameContentScenario,
  sameKeyConcurrentSourcesScenario,
  claim,
  claimBudgetScenario,
  deletedSourceScenario,
  ensure,
  ensureStartedScenario,
  fallbackReuseScenario,
  parserFailureScenario,
  heartbeatLossScenario,
  lostClaimStopsProvidersScenario,
  lostDuringLookupScenario,
  expire,
  mediaDerivativeScenario,
  ownerCacheScenario,
  ownerClaimMidRunScenario,
  publishRollbackScenario,
  quotaFailureScenario,
  sameBytesOtherMimeScenario,
  rootsOf,
  schemaCompatibilityScenario,
  seedSource,
  stateOf,
  supersededClaimScenario,
  twoConversationsOneExtractionScenario,
  uploadQueuesExtractionScenario,
  withdrawnDonorScenario,
  type ExtractionHarness,
} from './_owner-extraction-scenarios';

const contractUrl = process.env.PG_CONTRACT_URL;
/** Longer than any lock wait these races should see; a deadlock or a hang fails it. */
const RACE_BUDGET_MS = 15_000;

let serial = 0;

async function settleWithinBudget(promises: Promise<unknown>[]) {
  return Promise.race([
    Promise.allSettled(promises),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('race did not settle in time')), RACE_BUDGET_MS),
    ),
  ]);
}

/** The backend pid a connection of `pool` runs on, by its application name. */
async function backendOf(admin: Pool, applicationName: string): Promise<number | undefined> {
  const found = await admin.query<{ pid: number }>(
    'SELECT pid FROM pg_stat_activity WHERE application_name = $1',
    [applicationName],
  );
  return found.rows[0]?.pid;
}

/** Wait until `waiter` itself is blocked by `holder`, not merely until someone waits. */
async function waitUntilBlockedBy(admin: Pool, waiter: number, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const blocked = await admin.query<{ blocked: boolean }>(
      'SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked',
      [waiter, holder],
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the waiter never queued behind the holder');
}

describe.skipIf(!contractUrl)('owner-level material extraction on PostgreSQL', () => {
  let admin: Pool | undefined;
  const pools: Pool[] = [];
  let schema: string;

  async function boot(env: Record<string, string> = {}): Promise<ExtractionHarness> {
    serial += 1;
    schema = `openmaic_owner_extraction_test_${serial}`;
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      application_name: `owner-extraction-${serial}`,
      max: 8,
    });
    pools.push(pool);
    vi.stubEnv('ASSET_S3_BUCKET', '');
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const databaseUrl = `${contractUrl}${contractUrl!.includes('?') ? '&' : '?'}application_name=owner-extraction-${serial}`;
    vi.stubEnv('DATABASE_URL', databaseUrl);
    return bootExtractionHarness(pool as never, databaseUrl);
  }

  /** A connection of its own in the test schema, named so its backend can be found. */
  function namedPool(name: string): Pool {
    const pool = new Pool({
      connectionString: contractUrl,
      options: `-c search_path=${schema}`,
      application_name: name,
      max: 1,
    });
    pools.push(pool);
    return pool;
  }

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

  describe('races', () => {
    it('two workers claiming at once get one claim between them', async () => {
      const h = await boot();
      await seedSource(h, 'src-contested');
      await ensure(h, 'src-contested');
      const results = await settleWithinBudget([claim(h), claim(h), claim(h)]);
      const claims = results.flatMap((result) =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      );
      expect(claims).toHaveLength(1);
      expect((await stateOf(h, 'src-contested')).extraction_token).toBe(
        (claims[0] as { token: string }).token,
      );
    });

    it('a publication that meets a claim of its owner waits for it, then lands for the account', async () => {
      const h = await boot();
      await seedSource(h, 'src-anon', { owner: ANON });
      await ensure(h, 'src-anon', ANON);
      const current = (await claim(h))!;

      // Park a claim of ANON after every core participant: it holds both
      // owners' identity locks exclusively until the gate opens.
      let reach!: () => void;
      let open!: () => void;
      const reached = new Promise<void>((resolve) => (reach = resolve));
      const opened = new Promise<void>((resolve) => (open = resolve));
      registerClaimParticipant({
        name: 'test-gate',
        order: 1000,
        rekey: async () => {
          reach();
          await opened;
        },
      });
      const claimed = claimOwner(ANON, ACCOUNT, { provider: h.provider });
      await reached;

      // The run's publication goes through a named connection so its own
      // backend can be watched queueing behind the claim's.
      const publisher = namedPool(`owner-extraction-publisher-${serial}`);
      const withTransaction = async <T>(body: (tx: never) => Promise<T>): Promise<T> => {
        const client = await publisher.connect();
        try {
          await client.query('BEGIN');
          const result = await body(client as never);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      };
      const run = runClaimedOwnerExtraction(
        current,
        h.deps({ persistence: { ...h.provider, withTransaction: withTransaction as never } }),
      );
      const claimBackend = await admin!
        .query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE application_name = $1 AND state = 'idle in transaction'`,
          [`owner-extraction-${serial}`],
        )
        .then((result) => result.rows.map((row) => row.pid));
      let publisherPid: number | undefined;
      for (let attempt = 0; attempt < 400 && publisherPid === undefined; attempt += 1) {
        publisherPid = await backendOf(admin!, `owner-extraction-publisher-${serial}`);
        if (publisherPid === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(publisherPid).toBeDefined();
      expect(claimBackend.length).toBeGreaterThan(0);
      await Promise.any(
        claimBackend.map((holder) => waitUntilBlockedBy(admin!, publisherPid!, holder)),
      );
      open();

      const [claimResult, runResult] = await settleWithinBudget([claimed, run]);
      expect(claimResult).toMatchObject({ status: 'fulfilled', value: { status: 'claimed' } });
      expect(runResult).toMatchObject({ status: 'fulfilled', value: 'published' });
      const state = await stateOf(h, 'src-anon');
      expect(state).toMatchObject({ owner_id: ACCOUNT, status: 'done' });
      const entry = await h.pool.query<{ principal: string }>(
        'SELECT principal FROM asset_entries WHERE id = $1',
        [state.extraction_result!.text.assetId],
      );
      expect(entry.rows[0]).toEqual({ principal: `owner:${ACCOUNT}` });
    });

    it('a superseded publication racing the current one never wins', async () => {
      const h = await boot();
      await seedSource(h, 'src-race');
      await ensure(h, 'src-race');
      const stale = (await claim(h))!;
      expire(h);
      const current = (await claim(h))!;
      const text = await h.provider.withTransaction((tx) =>
        h.provider
          .assetStoreIn(tx)
          .put({ key: `owner:${ACCOUNT}` }, new Blob(['text']), { contentType: 'text/markdown' }),
      );
      const publication = (extractorId: string) => ({
        cacheKey: null,
        text: { assetId: text, chars: 4 },
        extractor: { id: extractorId, version: '1', options: {} },
        stats: {},
        derivatives: [
          {
            id: `frame-${randomUUID()}`,
            kind: 'image' as const,
            assetId: text,
            title: extractorId,
            mime: 'image/png',
            bytes: 4,
            sha256: 'x',
          },
        ],
      });
      const results = await settleWithinBudget([
        publishOwnerMaterialExtraction(
          h.provider.withTransaction,
          stale,
          publication('stale'),
          h.clock.now,
        ),
        publishOwnerMaterialExtraction(
          h.provider.withTransaction,
          current,
          publication('current'),
          h.clock.now,
        ),
      ]);
      expect(results.map((result) => (result as PromiseFulfilledResult<string>).value)).toEqual([
        'not-authorized',
        'published',
      ]);
      const state = await stateOf(h, 'src-race');
      expect(state.extraction_result).toMatchObject({
        revision: current.token,
        extractor: { id: 'current' },
      });
      const frames = await h.pool.query<{ original_name: string }>(
        `SELECT original_name FROM owner_material WHERE derived_from = 'src-race'`,
      );
      expect(frames.rows).toEqual([{ original_name: 'current' }]);
      expect(await rootsOf(h, 'src-race')).toEqual([text]);
    });
  });
});
